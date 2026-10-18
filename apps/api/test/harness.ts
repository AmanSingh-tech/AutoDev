import type { JobQueue, RepoSyncJob } from '@autodev/config';
import { createAppDb, createSystemDb, schema } from '@autodev/db';
import { testKms, TEST_APP_URL, TEST_SYSTEM_URL } from '@autodev/db/testing';
import { MemoryCache, RepoAccessService, TokenVault, type GitHubConfig } from '@autodev/github';
import { setupServer } from 'msw/node';
import type { Deps } from '../src/deps';
import { createCaller } from '../src/trpc/router';

export const API = 'http://github.test/api';
export const WEB_URL = 'http://web.test';
export const AUTH_SECRET = 'test-auth-secret-'.padEnd(48, 'x');

export const testCfg: GitHubConfig = {
  appId: 1,
  appSlug: 'autodev-test',
  privateKey: 'unused',
  clientId: 'Iv1.test',
  clientSecret: 'secret',
  webhookSecret: 'whsec_test_123456',
  apiUrl: API,
  webUrl: 'http://github.test',
};

export const msw = setupServer();

export function createTestDeps() {
  const app = createAppDb(TEST_APP_URL);
  const sys = createSystemDb(TEST_SYSTEM_URL);
  const cache = new MemoryCache();
  const vault = new TokenVault(sys.db, testKms, testCfg);
  const jobs: { name: string; data: RepoSyncJob }[] = [];
  const repoSync: JobQueue<RepoSyncJob> = {
    add: async (name, data) => {
      jobs.push({ name, data });
    },
  };
  const deps: Deps = {
    env: { WEB_URL, AUTH_SECRET, NODE_ENV: 'test' },
    app: app.db,
    sys: sys.db,
    kms: testKms,
    cfg: testCfg,
    vault,
    cache,
    repoAccess: new RepoAccessService({ app: app.db, sys: sys.db, vault, cache, cfg: testCfg }),
    queues: { repoSync },
  };
  return { deps, jobs, close: () => Promise.all([app.close(), sys.close()]) };
}

export function callerFor(deps: Deps, userId: string | null, orgId: string | null) {
  return createCaller({ deps, userId, orgId, ip: '127.0.0.1', userAgent: 'vitest' });
}

export async function addMember(deps: Deps, orgId: string, login: string, role: 'owner' | 'admin' | 'developer' | 'viewer') {
  const [u] = await deps.sys
    .insert(schema.users)
    .values({ githubUserId: Math.floor(Math.random() * 1e9), githubLogin: login })
    .returning();
  await deps.sys.insert(schema.orgMembers).values({ orgId, userId: u!.id, role });
  return u!;
}
