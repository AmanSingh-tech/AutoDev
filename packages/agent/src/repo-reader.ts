import { getBlob, getTree, listCommits, listDirAt, searchCode, type CommitSummary, type KvCache, type Octokit, type TreeEntry } from '@autodev/github';

/** Read-only view of the repo at the base commit. */
export interface RepoReader {
  tree(): Promise<{ entries: TreeEntry[]; truncated: boolean }>;
  listDir(path: string): Promise<TreeEntry[]>;
  readBlob(blobSha: string): Promise<Buffer>;
  /** Default-branch code search: a fallback when a bounded local search isn't possible. */
  search(query: string, path?: string): Promise<string[]>;
  /** Recent commits up to the base commit, optionally only those touching `path`. Used by repo chat. */
  log?(path?: string, limit?: number): Promise<CommitSummary[]>;
}

const CACHE_TTL = 24 * 3600;
const MAX_CACHED_VALUE = 512 * 1024;

/**
 * Reads through GitHub with the task owner's token. Trees and blobs are content-addressed (by
 * commit and blob sha), so caching them is always safe.
 */
export class GitHubRepoReader implements RepoReader {
  private treeMemo?: Promise<{ entries: TreeEntry[]; truncated: boolean }>;

  constructor(
    private readonly opts: {
      repoId: string;
      owner: string;
      name: string;
      baseSha: string;
      cache: KvCache;
      withClient: <T>(fn: (gh: Octokit) => Promise<T>) => Promise<T>;
    },
  ) {}

  tree() {
    this.treeMemo ??= (async () => {
      const key = `gh:tree:${this.opts.repoId}:${this.opts.baseSha}`;
      const hit = await this.opts.cache.get(key);
      if (hit) return JSON.parse(hit) as { entries: TreeEntry[]; truncated: boolean };
      const tree = await this.opts.withClient((gh) => getTree(gh, this.opts.owner, this.opts.name, this.opts.baseSha));
      const json = JSON.stringify(tree);
      if (json.length <= 8 * MAX_CACHED_VALUE) await this.opts.cache.set(key, json, CACHE_TTL);
      return tree;
    })();
    return this.treeMemo;
  }

  listDir(path: string) {
    return this.opts.withClient((gh) => listDirAt(gh, this.opts.owner, this.opts.name, this.opts.baseSha, path));
  }

  async readBlob(blobSha: string) {
    const key = `gh:blob:${this.opts.repoId}:${blobSha}`;
    const hit = await this.opts.cache.get(key);
    if (hit !== null) return Buffer.from(hit, 'base64');
    const buf = await this.opts.withClient((gh) => getBlob(gh, this.opts.owner, this.opts.name, blobSha));
    if (buf.length <= MAX_CACHED_VALUE) await this.opts.cache.set(key, buf.toString('base64'), CACHE_TTL);
    return buf;
  }

  search(query: string, path?: string) {
    return this.opts.withClient((gh) => searchCode(gh, this.opts.owner, this.opts.name, query, path ? { path } : {}));
  }

  log(path?: string, limit = 20) {
    return this.opts.withClient((gh) => listCommits(gh, this.opts.owner, this.opts.name, this.opts.baseSha, { ...(path ? { path } : {}), limit }));
  }
}

/** In-memory repo for tests. */
export class MemoryRepoReader implements RepoReader {
  private readonly blobs = new Map<string, Buffer>();
  private readonly entries: TreeEntry[] = [];

  constructor(files: Record<string, string>) {
    const dirs = new Set<string>();
    for (const [path, content] of Object.entries(files)) {
      const sha = `blob-${path}`;
      this.blobs.set(sha, Buffer.from(content));
      this.entries.push({ path, type: 'blob', sha, size: Buffer.byteLength(content) });
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    for (const d of dirs) this.entries.push({ path: d, type: 'tree', sha: `tree-${d}` });
  }
  async tree() {
    return { entries: this.entries, truncated: false };
  }
  async listDir(path: string) {
    return this.entries.filter((e) => e.path.startsWith(path ? `${path}/` : '') && !e.path.slice(path ? path.length + 1 : 0).includes('/'));
  }
  async readBlob(sha: string) {
    const b = this.blobs.get(sha);
    if (!b) throw new Error(`no blob ${sha}`);
    return b;
  }
  async search() {
    return [];
  }
}
