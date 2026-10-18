import { createAppDb, createSystemDb, eq, schema } from '@autodev/db';
import { makeOrg, testKms, TEST_APP_URL, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API, server, testCfg } from '../test/helpers';
import { RepoAccessService } from './access';
import { MemoryCache } from './cache';
import { TokenVault } from './vault';

const sys = createSystemDb(TEST_SYSTEM_URL);
const app = createAppDb(TEST_APP_URL);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await Promise.all([sys.close(), app.close()]);
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
let service: RepoAccessService;
let calls: number;

const ghRepo = (id: number, name: string, permissions: object, extra: object = {}) => ({
  id,
  name,
  full_name: `acme/${name}`,
  owner: { login: 'acme' },
  default_branch: 'main',
  private: true,
  archived: false,
  permissions,
  ...extra,
});

function githubReturns(list: object[]) {
  server.use(
    http.get(`${API}/user/installations/:id/repositories`, ({ request }) => {
      calls++;
      expect(request.headers.get('authorization')).toBe('token ghu_user_token');
      return HttpResponse.json({ total_count: list.length, repositories: list });
    }),
  );
}

beforeEach(async () => {
  await truncateAll(sys.db);
  fx = await makeOrg(sys.db, 'acme');
  const vault = new TokenVault(sys.db, testKms, testCfg);
  await vault.store(fx.owner.id, {
    accessToken: 'ghu_user_token',
    refreshToken: null,
    accessExpiresAt: null,
    refreshExpiresAt: null,
  });
  service = new RepoAccessService({ app: app.db, sys: sys.db, vault, cache: new MemoryCache(), cfg: testCfg });
  calls = 0;
});

describe('RepoAccessService', () => {
  it('lists only repos with push, maintain or admin', async () => {
    githubReturns([
      ghRepo(1, 'web', { push: true, pull: true }),
      ghRepo(2, 'api', { admin: true, push: true }),
      ghRepo(3, 'infra', { maintain: true }),
      ghRepo(4, 'docs', { pull: true }),
      ghRepo(5, 'triaged', { triage: true, pull: true }),
      ghRepo(6, 'old', { admin: true }, { archived: true }),
    ]);
    const list = await service.listWritable(fx.org.id, fx.owner.id);
    expect(list.map((r) => [r.name, r.permission])).toEqual([
      ['api', 'admin'],
      ['infra', 'maintain'],
      ['web', 'push'],
    ]);
  });

  it('serves from cache within the TTL and refetches after invalidation', async () => {
    githubReturns([ghRepo(1, 'web', { push: true })]);
    await service.listWritable(fx.org.id, fx.owner.id);
    await service.listWritable(fx.org.id, fx.owner.id);
    expect(calls).toBe(1);

    await service.invalidateUser(fx.org.id, fx.owner.id);
    await service.listWritable(fx.org.id, fx.owner.id);
    expect(calls).toBe(2);

    await service.invalidateOrg(fx.org.id);
    await service.listWritable(fx.org.id, fx.owner.id);
    expect(calls).toBe(3);
  });

  it('drops a repo after the user loses write access', async () => {
    githubReturns([ghRepo(1, 'web', { push: true })]);
    expect(await service.listWritable(fx.org.id, fx.owner.id)).toHaveLength(1);

    githubReturns([ghRepo(1, 'web', { pull: true })]);
    expect(await service.listWritable(fx.org.id, fx.owner.id, { force: true })).toEqual([]);
  });

  it("does not take over a repo row owned by another org", async () => {
    const other = await makeOrg(sys.db, 'globex');
    githubReturns([ghRepo(other.repo.githubRepoId, 'hijack', { admin: true })]);
    expect(await service.listWritable(fx.org.id, fx.owner.id)).toEqual([]);
    const [row] = await sys.db.select().from(schema.repos).where(eq(schema.repos.id, other.repo.id));
    expect(row!.orgId).toBe(other.org.id);
    expect(row!.name).toBe('web');
  });

  it('treats an installation the user cannot see as having no repos', async () => {
    server.use(
      http.get(`${API}/user/installations/:id/repositories`, () => new HttpResponse(null, { status: 403 })),
    );
    expect(await service.listWritable(fx.org.id, fx.owner.id)).toEqual([]);
  });
});
