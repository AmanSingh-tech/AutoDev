import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { API, server, testCfg } from '../test/helpers';
import { getBranch, isValidBranchName, listBranches, MAX_BRANCHES, newBranchName } from './branches';
import { userOctokit } from './clients';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const gh = userOctokit(testCfg, 't');
const branch = (name: string) => ({ name, commit: { sha: `sha-${name}`, url: '' }, protected: name === 'main' });

describe('listBranches', () => {
  it('follows pagination', async () => {
    server.use(
      http.get(`${API}/repos/acme/web/branches`, ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get('page') ?? 1);
        const headers = page === 1 ? { link: `<${API}/repos/acme/web/branches?per_page=100&page=2>; rel="next"` } : undefined;
        return HttpResponse.json(page === 1 ? [branch('main'), branch('dev')] : [branch('feature/x')], { headers });
      }),
    );
    const res = await listBranches(gh, 'acme', 'web');
    expect(res).toEqual({ truncated: false, branches: [branch('main'), branch('dev'), branch('feature/x')].map((b) => ({ name: b.name, sha: b.commit.sha, protected: b.protected })) });
  });

  it('stops at the cap and says so', async () => {
    server.use(
      http.get(`${API}/repos/acme/web/branches`, ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get('page') ?? 1);
        return HttpResponse.json(
          Array.from({ length: 100 }, (_, i) => branch(`b${page}-${i}`)),
          { headers: { link: `<${API}/repos/acme/web/branches?per_page=100&page=${page + 1}>; rel="next"` } },
        );
      }),
    );
    const res = await listBranches(gh, 'acme', 'web');
    expect(res.truncated).toBe(true);
    expect(res.branches).toHaveLength(MAX_BRANCHES);
  });
});

describe('getBranch', () => {
  it('returns null for a missing branch', async () => {
    server.use(http.get(`${API}/repos/acme/web/branches/:b`, () => new HttpResponse(null, { status: 404 })));
    expect(await getBranch(gh, 'acme', 'web', 'nope')).toBeNull();
  });

  it('encodes slashes in branch names', async () => {
    server.use(http.get(`${API}/repos/acme/web/branches/:b`, ({ params }) => HttpResponse.json(branch(params.b as string))));
    expect(await getBranch(gh, 'acme', 'web', 'feature/login')).toMatchObject({ name: 'feature/login', sha: 'sha-feature/login' });
  });
});

describe('branch names', () => {
  it('builds autodev/<KEY>-<slug>', () => {
    expect(newBranchName('AD-142', 'Fix login redirect when SSO is enforced!')).toBe('autodev/AD-142-fix-login-redirect-when-sso-is-enforced');
    expect(newBranchName('AD-7', 'Ünïcode títle — 日本語')).toBe('autodev/AD-7-unicode-title');
    expect(newBranchName('AD-8', '日本語')).toBe('autodev/AD-8');
  });

  it('rejects invalid git ref names', () => {
    for (const bad of ['', 'a b', 'a..b', '/x', 'x/', 'x.lock', 'a~b', 'a:b', 'a//b', '@']) expect(isValidBranchName(bad)).toBe(false);
    for (const ok of ['main', 'feature/login-2', 'release-1.2']) expect(isValidBranchName(ok)).toBe(true);
  });
});
