import { and, eq, inArray, schema, sql, type SystemDb } from '@autodev/db';
import { getBlob, getBranchHead, getTree, installationOctokit, type GitHubConfig, type TreeEntry } from '@autodev/github';
import { chunkFile, type Chunk } from './chunker';
import { words, type Embedder } from './embedder';
import { looksBinary, MAX_FILES_PER_REPO, shouldIndex } from './files';

const { codeChunks, codeIndexState, installations, orgs, repos } = schema;

/** The org setting that turns the index on. Off unless an admin turns it on. */
export function codeIndexEnabled(settings: Record<string, unknown> | null | undefined): boolean {
  return settings?.storeCodeIndex === true;
}

/** The repo at its default branch, read with the installation token (no person is involved in indexing). */
export interface RepoSource {
  head(): Promise<string>;
  tree(sha: string): Promise<{ entries: TreeEntry[]; truncated: boolean }>;
  readBlob(sha: string): Promise<Buffer>;
}

export interface RepoRef {
  owner: string;
  name: string;
  defaultBranch: string;
  githubInstallationId: number;
}

export function githubSource(cfg: GitHubConfig, repo: RepoRef): RepoSource {
  const gh = installationOctokit(cfg, repo.githubInstallationId);
  return {
    head: () => getBranchHead(gh, repo.owner, repo.name, repo.defaultBranch),
    tree: (sha) => getTree(gh, repo.owner, repo.name, sha),
    readBlob: (sha) => getBlob(gh, repo.owner, repo.name, sha),
  };
}

export interface CodeIndexerDeps {
  sys: SystemDb;
  embedder: Embedder;
  sourceFor: (repo: RepoRef) => RepoSource;
  /** Files read from GitHub at once. */
  readConcurrency?: number;
  /** Test seam for the per-repo file cap. */
  maxFiles?: number;
}

export type SyncResult =
  | { status: 'disabled' | 'unavailable' }
  | { status: 'ready'; commitSha: string; added: number; removed: number; files: number; chunks: number; skippedFiles: number };

/** Chunks embedded and written per batch. A batch is one INSERT, so a file is never half-indexed. */
const EMBED_BATCH = 64;
/** A push during a run is picked up by running again, at most this many times. */
const MAX_CATCH_UP_RUNS = 3;

export class CodeIndexer {
  constructor(private readonly deps: CodeIndexerDeps) {}

  /**
   * Brings one repo's index up to its default branch head. Incremental: only files whose blob
   * changed are read and embedded, and files that are gone lose their chunks. Safe to re-run.
   */
  async syncRepo(orgId: string, repoId: string): Promise<SyncResult> {
    const repo = await this.loadRepo(orgId, repoId);
    if (!repo) return { status: 'unavailable' };
    if (!repo.enabled) {
      await this.purgeRepo(repoId);
      return { status: 'disabled' };
    }
    const source = this.deps.sourceFor(repo);
    await this.deps.sys
      .insert(codeIndexState)
      .values({ repoId, orgId, status: 'indexing', startedAt: new Date(), error: null })
      .onConflictDoUpdate({ target: codeIndexState.repoId, set: { status: 'indexing', startedAt: new Date(), error: null } });

    try {
      let result = await this.runOnce(orgId, repoId, source);
      for (let i = 1; i < MAX_CATCH_UP_RUNS && result.status === 'ready' && (await source.head()) !== result.commitSha; i++) {
        result = await this.runOnce(orgId, repoId, source);
      }
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.deps.sys.update(codeIndexState).set({ status: 'failed', error: message.slice(0, 1000), finishedAt: new Date() }).where(eq(codeIndexState.repoId, repoId));
      throw e;
    }
  }

  private async runOnce(orgId: string, repoId: string, source: RepoSource): Promise<SyncResult> {
    const { sys, embedder } = this.deps;
    const head = await source.head();
    const tree = await source.tree(head);
    const candidates = tree.entries
      .filter((e) => e.type === 'blob' && e.mode !== '120000' && e.mode !== '160000' && shouldIndex(e.path, e.size))
      .sort((a, b) => a.path.localeCompare(b.path));
    const cap = this.deps.maxFiles ?? MAX_FILES_PER_REPO;
    const wanted = new Map(candidates.slice(0, cap).map((e) => [e.path, e.sha]));
    const skippedFiles = Math.max(0, candidates.length - cap);

    // A different model's vectors can't be compared with this one's, so start over.
    const [state] = await sys.select({ model: codeIndexState.model }).from(codeIndexState).where(eq(codeIndexState.repoId, repoId));
    if (state?.model && state.model !== embedder.model) await sys.delete(codeChunks).where(eq(codeChunks.repoId, repoId));

    const indexed = new Map<string, string>();
    const rows = await sys.selectDistinct({ path: codeChunks.path, blobSha: codeChunks.blobSha }).from(codeChunks).where(eq(codeChunks.repoId, repoId));
    for (const r of rows) indexed.set(r.path, r.blobSha);

    const stale = [...indexed].filter(([path, sha]) => wanted.get(path) !== sha).map(([path]) => path);
    for (let i = 0; i < stale.length; i += 500)
      await sys.delete(codeChunks).where(and(eq(codeChunks.repoId, repoId), inArray(codeChunks.path, stale.slice(i, i + 500))));
    const todo = [...wanted].filter(([path, sha]) => indexed.get(path) !== sha);

    let pending: { path: string; sha: string; chunk: Chunk }[] = [];
    const flush = async () => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      const vectors = await embedder.embed(batch.map((b) => embeddingText(b.path, b.chunk)));
      await sys.insert(codeChunks).values(
        batch.map((b, i) => ({
          orgId,
          repoId,
          path: b.path,
          blobSha: b.sha,
          startLine: b.chunk.startLine,
          endLine: b.chunk.endLine,
          language: b.chunk.language,
          symbol: b.chunk.symbol,
          content: b.chunk.content,
          tsv: sql`to_tsvector('simple', ${searchText(b.path, b.chunk)})`,
          embedding: vectors[i]!,
        })),
      );
    };

    const concurrency = this.deps.readConcurrency ?? 8;
    for (let i = 0; i < todo.length; i += concurrency) {
      // Turned off mid-run: stop, and leave nothing behind.
      if (i > 0 && i % (concurrency * 25) === 0 && !(await this.enabled(orgId))) {
        await this.purgeRepo(repoId);
        return { status: 'disabled' };
      }
      const files = await Promise.all(
        todo.slice(i, i + concurrency).map(async ([path, sha]) => {
          const buf = await source.readBlob(sha);
          // A binary or empty file has no chunks, so the next run reads it again. The extension filter keeps these rare.
          return { path, sha, chunks: looksBinary(buf) ? [] : await chunkFile(path, buf.toString('utf8')) };
        }),
      );
      for (const f of files) {
        // A file's chunks always go in the same batch, so it is indexed whole or not at all.
        if (pending.length > 0 && pending.length + f.chunks.length > EMBED_BATCH) await flush();
        for (const chunk of f.chunks) pending.push({ path: f.path, sha: f.sha, chunk });
      }
    }
    await flush();

    if (!(await this.enabled(orgId))) {
      await this.purgeRepo(repoId);
      return { status: 'disabled' };
    }
    const [counts] = await sys
      .select({ files: sql<number>`count(distinct ${codeChunks.path})::int`, chunks: sql<number>`count(*)::int` })
      .from(codeChunks)
      .where(eq(codeChunks.repoId, repoId));
    const files = counts?.files ?? 0;
    const chunks = counts?.chunks ?? 0;
    const done = {
      status: 'ready' as const,
      commitSha: head,
      model: embedder.model,
      files,
      chunks,
      skippedFiles,
      error: tree.truncated ? 'GitHub returned only part of this repository’s file list, so some files are not indexed.' : null,
      finishedAt: new Date(),
    };
    // An upsert: a purge followed by turning the index back on can delete the row mid-run.
    await sys.insert(codeIndexState).values({ repoId, orgId, ...done }).onConflictDoUpdate({ target: codeIndexState.repoId, set: done });
    return { status: 'ready', commitSha: head, added: todo.length, removed: stale.length, files, chunks, skippedFiles };
  }

  /** The org's repos that the index should cover (the worker queues one job per repo). */
  async reposOf(orgId: string): Promise<string[]> {
    if (!(await this.enabled(orgId))) return [];
    const rows = await this.deps.sys
      .select({ id: repos.id })
      .from(repos)
      .innerJoin(installations, eq(installations.id, repos.installationId))
      .where(and(eq(repos.orgId, orgId), sql`${repos.deletedAt} is null`, sql`${installations.deletedAt} is null`, sql`${installations.suspendedAt} is null`));
    return rows.map((r) => r.id);
  }

  /** Orgs with the index turned on, for the nightly catch-up. */
  async enabledOrgs(): Promise<string[]> {
    const rows = await this.deps.sys.select({ id: orgs.id }).from(orgs).where(sql`(${orgs.settings}->>'storeCodeIndex')::boolean is true`);
    return rows.map((r) => r.id);
  }

  /** Deletes every chunk and index state of an org. Used when the setting is turned off. */
  async purgeOrg(orgId: string): Promise<{ chunks: number }> {
    const deleted = await this.deps.sys.delete(codeChunks).where(eq(codeChunks.orgId, orgId)).returning({ id: codeChunks.id });
    await this.deps.sys.delete(codeIndexState).where(eq(codeIndexState.orgId, orgId));
    return { chunks: deleted.length };
  }

  private async purgeRepo(repoId: string) {
    await this.deps.sys.delete(codeChunks).where(eq(codeChunks.repoId, repoId));
    await this.deps.sys.delete(codeIndexState).where(eq(codeIndexState.repoId, repoId));
  }

  private async enabled(orgId: string) {
    const [org] = await this.deps.sys.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, orgId));
    return codeIndexEnabled(org?.settings);
  }

  private async loadRepo(orgId: string, repoId: string): Promise<(RepoRef & { enabled: boolean }) | null> {
    const [row] = await this.deps.sys
      .select({ repo: repos, inst: installations, settings: orgs.settings })
      .from(repos)
      .innerJoin(installations, eq(installations.id, repos.installationId))
      .innerJoin(orgs, eq(orgs.id, repos.orgId))
      .where(and(eq(repos.id, repoId), eq(repos.orgId, orgId)));
    if (!row || row.repo.deletedAt || row.inst.deletedAt || row.inst.suspendedAt) return null;
    return {
      owner: row.repo.owner,
      name: row.repo.name,
      defaultBranch: row.repo.defaultBranch,
      githubInstallationId: row.inst.githubInstallationId,
      enabled: codeIndexEnabled(row.settings),
    };
  }
}

/** What the model embeds: the location gives it context the code alone may not have. */
export function embeddingText(path: string, chunk: Pick<Chunk, 'symbol' | 'content'>) {
  return `${path}${chunk.symbol ? ` (${chunk.symbol})` : ''}\n${chunk.content}`;
}

/** What keyword search matches: every word, with identifiers also split into their parts. */
export function searchText(path: string, chunk: Pick<Chunk, 'symbol' | 'content'>) {
  return words(`${path} ${chunk.symbol ?? ''} ${chunk.content}`).join(' ');
}
