import { createSystemDb, eq, schema } from '@autodev/db';
import { makeOrg, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API, server, testCfg } from '../test/helpers';
import { userOctokit } from './clients';
import { syncInstallationRepos } from './sync';

const sys = createSystemDb(TEST_SYSTEM_URL);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await sys.close();
});
beforeEach(() => truncateAll(sys.db));

describe('syncInstallationRepos', () => {
  it('upserts listed repos and soft-deletes the ones that are gone', async () => {
    const fx = await makeOrg(sys.db, 'acme'); // has acme/web
    server.use(
      http.get(`${API}/installation/repositories`, () =>
        HttpResponse.json({
          total_count: 1,
          repositories: [
            { id: 77, name: 'api', full_name: 'acme/api', owner: { login: 'acme' }, default_branch: 'dev', private: false, archived: false },
          ],
        }),
      ),
    );
    // Installation auth isn't under test here, so a plain token client stands in.
    const res = await syncInstallationRepos(sys.db, userOctokit(testCfg, 'x'), fx.installation.githubInstallationId);
    expect(res).toEqual({ upserted: 1, removed: 1 });

    const rows = await sys.db.select().from(schema.repos).where(eq(schema.repos.orgId, fx.org.id));
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.api!.defaultBranch).toBe('dev');
    expect(byName.api!.deletedAt).toBeNull();
    expect(byName.web!.deletedAt).not.toBeNull();
  });
});
