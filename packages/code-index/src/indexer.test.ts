import { createAppDb, createSystemDb, eq, schema, withOrg } from '@autodev/db';
import { makeOrg, TEST_APP_URL, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import type { TreeEntry } from '@autodev/github';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeEmbedder } from './embedder';
import { CodeIndexer, type RepoSource } from './indexer';
import { IndexedCodeSearch } from './search';

const { codeChunks, codeIndexState, orgMembers, orgs, userRepoAccess, users } = schema;
const sys = createSystemDb(TEST_SYSTEM_URL);
const app = createAppDb(TEST_APP_URL);
afterAll(async () => {
  await Promise.all([sys.close(), app.close()]);
});

/** A repo whose files can change between runs, like a branch receiving pushes. */
class FakeRepo implements RepoSource {
  commit = 1;
  reads: string[] = [];
  /** Called after each tree read, to simulate a push arriving mid-run. */
  onTree?: () => void;
  constructor(public files: Record<string, string>) {}
  push(change: Record<string, string | null>) {
    for (const [p, c] of Object.entries(change)) if (c === null) delete this.files[p];
    else this.files[p] = c;
    this.commit++;
  }
  async head() {
    return `sha${this.commit}`;
  }
  async tree() {
    const entries: TreeEntry[] = Object.entries(this.files).map(([path, c]) => ({ path, type: 'blob', sha: `b:${path}:${c.length}:${hash(c)}`, size: c.length }));
    this.onTree?.();
    return { entries, truncated: false };
  }
  async readBlob(sha: string) {
    const path = sha.split(':')[1]!;
    this.reads.push(path);
    return Buffer.from(this.files[path] ?? '');
  }
}
const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7);

const FILES = {
  'src/auth/session.ts': 'export function createSession(userId: string) {\n  return signToken({ userId, expires: Date.now() + 3600 });\n}\n',
  'src/billing/invoice.ts': 'export function totalInvoice(lines: { price: number; qty: number }[]) {\n  return lines.reduce((sum, l) => sum + l.price * l.qty, 0);\n}\n',
  'src/http/router.go': 'package http\n\nfunc RegisterRoutes(mux *Mux) {\n  mux.Handle("/health", healthHandler)\n}\n',
  'README.md': '# Shop\n\nAn online shop.\n',
  'node_modules/lib/index.js': 'module.exports = 1;\n',
  'logo.png': 'PNG',
};

let fx: Awaited<ReturnType<typeof makeOrg>>;
let repo: FakeRepo;
let embedder: FakeEmbedder;
let indexer: CodeIndexer;
const enable = (on: boolean) => sys.db.update(orgs).set({ settings: { storeCodeIndex: on } }).where(eq(orgs.id, fx.org.id));

beforeEach(async () => {
  await truncateAll(sys.db);
  fx = await makeOrg(sys.db, 'acme');
  await enable(true);
  repo = new FakeRepo({ ...FILES });
  embedder = new FakeEmbedder();
  indexer = new CodeIndexer({ sys: sys.db, embedder, sourceFor: () => repo });
});

const paths = async () => (await sys.db.selectDistinct({ path: codeChunks.path }).from(codeChunks)).map((r) => r.path).sort();
const state = async () => (await sys.db.select().from(codeIndexState).where(eq(codeIndexState.repoId, fx.repo.id)))[0];

describe('CodeIndexer', () => {
  it('indexes the default branch, skipping vendored and binary files', async () => {
    const r = await indexer.syncRepo(fx.org.id, fx.repo.id);
    expect(r).toMatchObject({ status: 'ready', commitSha: 'sha1', added: 4, removed: 0, files: 4, skippedFiles: 0 });
    expect(await paths()).toEqual(['README.md', 'src/auth/session.ts', 'src/billing/invoice.ts', 'src/http/router.go']);
    expect(await state()).toMatchObject({ status: 'ready', commitSha: 'sha1', model: embedder.model, files: 4, error: null });
    const [chunk] = await sys.db.select().from(codeChunks).where(eq(codeChunks.path, 'src/http/router.go'));
    expect(chunk).toMatchObject({ startLine: 1, endLine: 5, symbol: 'RegisterRoutes', language: 'go' });
  });

  it('re-reads only changed files, and drops deleted ones', async () => {
    await indexer.syncRepo(fx.org.id, fx.repo.id);
    repo.reads = [];
    const before = embedder.calls;
    repo.push({ 'src/billing/invoice.ts': 'export function totalInvoice() {\n  return 0;\n}\n', 'README.md': null, 'src/new.py': 'def hello():\n    return "hi"\n' });

    const r = await indexer.syncRepo(fx.org.id, fx.repo.id);
    expect(r).toMatchObject({ status: 'ready', commitSha: 'sha2', added: 2, removed: 2, files: 4 });
    expect(repo.reads.sort()).toEqual(['src/billing/invoice.ts', 'src/new.py']);
    expect(embedder.calls - before).toBe(2);
    expect(await paths()).toEqual(['src/auth/session.ts', 'src/billing/invoice.ts', 'src/http/router.go', 'src/new.py']);
    const invoice = await sys.db.select().from(codeChunks).where(eq(codeChunks.path, 'src/billing/invoice.ts'));
    expect(invoice).toHaveLength(1);
    expect(invoice[0]!.content).toContain('return 0');

    // Nothing changed: nothing read.
    repo.reads = [];
    expect(await indexer.syncRepo(fx.org.id, fx.repo.id)).toMatchObject({ added: 0, removed: 0 });
    expect(repo.reads).toEqual([]);
  });

  it('runs again when a push lands during a run', async () => {
    repo.onTree = () => {
      repo.onTree = undefined;
      repo.push({ 'src/late.ts': 'export const late = 1;\n' });
    };
    const r = await indexer.syncRepo(fx.org.id, fx.repo.id);
    expect(r).toMatchObject({ status: 'ready', commitSha: 'sha2' });
    expect(await paths()).toContain('src/late.ts');
  });

  it('caps the files per repo and counts the rest', async () => {
    indexer = new CodeIndexer({ sys: sys.db, embedder, sourceFor: () => repo, maxFiles: 2 });
    expect(await indexer.syncRepo(fx.org.id, fx.repo.id)).toMatchObject({ files: 2, skippedFiles: 2 });
    expect(await state()).toMatchObject({ skippedFiles: 2 });
  });

  it('starts over when the embedding model changes', async () => {
    await indexer.syncRepo(fx.org.id, fx.repo.id);
    const other = new FakeEmbedder();
    Object.defineProperty(other, 'model', { value: 'another-model' });
    repo.reads = [];
    await new CodeIndexer({ sys: sys.db, embedder: other, sourceFor: () => repo }).syncRepo(fx.org.id, fx.repo.id);
    expect(repo.reads).toHaveLength(4);
    expect(await state()).toMatchObject({ model: 'another-model', files: 4 });
  });

  it('records a failure and keeps the earlier chunks', async () => {
    await indexer.syncRepo(fx.org.id, fx.repo.id);
    repo.push({ 'src/x.ts': 'export const x = 1;\n' });
    repo.readBlob = async () => {
      throw new Error('GitHub is down');
    };
    await expect(indexer.syncRepo(fx.org.id, fx.repo.id)).rejects.toThrow('GitHub is down');
    expect(await state()).toMatchObject({ status: 'failed', error: 'GitHub is down', commitSha: 'sha1' });
    expect(await paths()).toHaveLength(4);
  });

  it('does nothing and deletes the index when the setting is off', async () => {
    await indexer.syncRepo(fx.org.id, fx.repo.id);
    await enable(false);
    expect(await indexer.syncRepo(fx.org.id, fx.repo.id)).toEqual({ status: 'disabled' });
    expect(await paths()).toEqual([]);
    expect(await state()).toBeUndefined();
  });

  it('purges one org without touching another', async () => {
    const other = await makeOrg(sys.db, 'globex');
    await sys.db.update(orgs).set({ settings: { storeCodeIndex: true } }).where(eq(orgs.id, other.org.id));
    await indexer.syncRepo(fx.org.id, fx.repo.id);
    await indexer.syncRepo(other.org.id, other.repo.id);
    expect((await indexer.purgeOrg(fx.org.id)).chunks).toBe(4);
    const left = await sys.db.selectDistinct({ orgId: codeChunks.orgId }).from(codeChunks);
    expect(left).toEqual([{ orgId: other.org.id }]);
    expect(await indexer.enabledOrgs()).toEqual(expect.arrayContaining([fx.org.id, other.org.id]));
    expect(await indexer.reposOf(other.org.id)).toEqual([other.repo.id]);
  });
});

describe('IndexedCodeSearch', () => {
  it('finds code by meaning and by name, and returns null without an index', async () => {
    const search = new IndexedCodeSearch({ sys: sys.db, embedder });
    expect(await search.search(fx.org.id, fx.repo.id, 'session')).toBeNull();
    await indexer.syncRepo(fx.org.id, fx.repo.id);

    const byName = await search.search(fx.org.id, fx.repo.id, 'RegisterRoutes');
    expect(byName!.commitSha).toBe('sha1');
    expect(byName!.hits[0]).toMatchObject({ path: 'src/http/router.go', startLine: 1, symbol: 'RegisterRoutes' });
    // Split identifiers: "total invoice" finds totalInvoice.
    const byWords = await search.search(fx.org.id, fx.repo.id, 'where is the total of an invoice computed?');
    expect(byWords!.hits[0]!.path).toBe('src/billing/invoice.ts');

    await enable(false);
    expect(await search.search(fx.org.id, fx.repo.id, 'session')).toBeNull();
  });
});

describe('code index RLS', () => {
  it('shows chunks only to people with access to the repo, and never lets them write', async () => {
    await indexer.syncRepo(fx.org.id, fx.repo.id);
    const [reader, outsider] = await sys.db.insert(users).values([{ githubUserId: 9_300_001, githubLogin: 'reader' }, { githubUserId: 9_300_002, githubLogin: 'outsider' }]).returning();
    await sys.db.insert(orgMembers).values([reader!, outsider!].map((u) => ({ orgId: fx.org.id, userId: u.id, role: 'developer' as const })));
    await sys.db.insert(userRepoAccess).values({ orgId: fx.org.id, repoId: fx.repo.id, userId: reader!.id, permission: 'pull', fetchedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) });

    const as = <T>(u: { id: string }, fn: Parameters<typeof withOrg<T>>[3]) => withOrg(app.db, fx.org.id, u.id, fn);
    expect((await as(reader!, (tx) => tx.select().from(codeChunks))).length).toBeGreaterThan(0);
    expect(await as(reader!, (tx) => tx.select().from(codeIndexState))).toHaveLength(1);
    expect(await as(outsider!, (tx) => tx.select().from(codeChunks))).toEqual([]);
    expect(await as(outsider!, (tx) => tx.select().from(codeIndexState))).toEqual([]);
    await expect(as(reader!, (tx) => tx.delete(codeChunks))).rejects.toThrow(/permission denied/);
    await expect(as(reader!, (tx) => tx.update(codeIndexState).set({ status: 'failed' }))).rejects.toThrow(/permission denied/);
  });
});
