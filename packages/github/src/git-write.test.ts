import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { API, server, testCfg } from '../test/helpers';
import { userOctokit } from './clients';
import { commitToBranch, PushConflict } from './git-write';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const R = `${API}/repos/acme/web`;
const gh = userOctokit(testCfg, 'ghu_user');
const BASE = 'b'.repeat(40);

/** A tiny in-memory GitHub git database that records what was written. */
function gitDb(opts: { head: string | null; compare?: { status: string; files: { filename: string }[] } }) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let n = 0;
  const rec = async (method: string, path: string, request: Request) => {
    const body = method === 'GET' ? undefined : await request.json();
    calls.push({ method, path, body });
    return body;
  };
  server.use(
    http.get(`${R}/git/ref/:ref`, async ({ request }) => (await rec('GET', 'ref', request), opts.head ? HttpResponse.json({ object: { sha: opts.head } }) : new HttpResponse(null, { status: 404 }))),
    http.get(`${R}/compare/:range`, async ({ request }) => (await rec('GET', 'compare', request), HttpResponse.json(opts.compare ?? { status: 'ahead', files: [] }))),
    http.get(`${R}/git/commits/:sha`, async ({ request, params }) => (await rec('GET', `commit:${params.sha}`, request), HttpResponse.json({ sha: params.sha, tree: { sha: `tree-of-${params.sha}` } }))),
    http.post(`${R}/git/blobs`, async ({ request }) => (await rec('POST', 'blob', request), HttpResponse.json({ sha: `blob${++n}` }, { status: 201 }))),
    http.post(`${R}/git/trees`, async ({ request }) => (await rec('POST', 'tree', request), HttpResponse.json({ sha: 'newtree' }, { status: 201 }))),
    http.post(`${R}/git/commits`, async ({ request }) => (await rec('POST', 'commit', request), HttpResponse.json({ sha: 'newcommit' }, { status: 201 }))),
    http.patch(`${R}/git/refs/:ref`, async ({ request }) => (await rec('PATCH', 'ref', request), HttpResponse.json({ object: { sha: 'newcommit' } }))),
    http.post(`${R}/git/refs`, async ({ request }) => (await rec('POST', 'refs', request), HttpResponse.json({ ref: 'x' }, { status: 201 }))),
  );
  return calls;
}

const changes = [
  { path: 'src/app.ts', op: 'modify' as const, content: 'hello\n', mode: '100755' },
  { path: 'src/new.ts', op: 'create' as const, content: 'x\n' },
  { path: 'README.md', op: 'delete' as const, content: null },
];
const input = { owner: 'acme', repo: 'web', branch: 'autodev/AD-1-greet', baseSha: BASE, changes, message: 'AD-1: Greet' };

describe('commitToBranch', () => {
  it('creates a new branch from the base commit with blobs, a tree (deletions as null) and a commit', async () => {
    const calls = gitDb({ head: null });
    const res = await commitToBranch(gh, input);
    expect(res).toEqual({ commitSha: 'newcommit', createdBranch: true, parentSha: BASE });
    const tree = calls.find((c) => c.path === 'tree')!.body as { base_tree: string; tree: unknown[] };
    expect(tree.base_tree).toBe(`tree-of-${BASE}`);
    expect(tree.tree).toEqual([
      { path: 'src/app.ts', mode: '100755', type: 'blob', sha: 'blob1' },
      { path: 'src/new.ts', mode: '100644', type: 'blob', sha: 'blob2' },
      { path: 'README.md', mode: '100644', type: 'blob', sha: null },
    ]);
    expect(calls.find((c) => c.path === 'commit')!.body).toEqual({ message: 'AD-1: Greet', tree: 'newtree', parents: [BASE] });
    expect(calls.find((c) => c.path === 'refs')!.body).toEqual({ ref: 'refs/heads/autodev/AD-1-greet', sha: 'newcommit' });
  });

  it('fast-forwards an existing branch, never forcing', async () => {
    const calls = gitDb({ head: BASE });
    expect((await commitToBranch(gh, input)).createdBranch).toBe(false);
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ sha: 'newcommit', force: false });
    expect(calls.some((c) => c.path === 'compare')).toBe(false);
  });

  it('builds on top of a branch that moved upstream in other files', async () => {
    const moved = 'm'.repeat(40);
    const calls = gitDb({ head: moved, compare: { status: 'ahead', files: [{ filename: 'docs/x.md' }] } });
    const res = await commitToBranch(gh, input);
    expect(res.parentSha).toBe(moved);
    expect((calls.find((c) => c.path === 'commit')!.body as { parents: string[] }).parents).toEqual([moved]);
  });

  it('refuses when upstream touched the same files, or history diverged', async () => {
    gitDb({ head: 'm'.repeat(40), compare: { status: 'ahead', files: [{ filename: 'src/app.ts' }] } });
    const err = await commitToBranch(gh, input).catch((e) => e);
    expect(err).toBeInstanceOf(PushConflict);
    expect(err.paths).toEqual(['src/app.ts']);

    gitDb({ head: 'm'.repeat(40), compare: { status: 'diverged', files: [] } });
    await expect(commitToBranch(gh, input)).rejects.toBeInstanceOf(PushConflict);
  });
});
