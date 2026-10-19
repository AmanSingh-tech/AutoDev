import { Publisher } from '@autodev/agent';
import { createSystemDb, eq, schema } from '@autodev/db';
import { makeOrg, testKms, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import { MemoryCache, TokenVault, type GitHubConfig } from '@autodev/github';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeGitHub } from '../../../packages/agent/test/fake-github';
import { sweepStaleBranches } from './stale-branch';

const API = 'http://github.test/api';
const cfg: GitHubConfig = { appId: 1, appSlug: 'x', privateKey: 'x', clientId: 'x', clientSecret: 'x', webhookSecret: 'x'.repeat(16), apiUrl: API, webUrl: 'http://github.test' };
const sys = createSystemDb(TEST_SYSTEM_URL);
const server = setupServer();
const vault = new TokenVault(sys.db, testKms, cfg);
const publisher = new Publisher({ sys: sys.db, vault, cfg, cache: new MemoryCache(), webUrl: 'http://web.test' });
const BASE = 'a'.repeat(40);
const DAY = 86_400_000;

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await sys.close();
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
let gh: ReturnType<typeof fakeGitHub>;
beforeEach(async () => {
  await truncateAll(sys.db);
  fx = await makeOrg(sys.db, 'acme');
  await vault.store(fx.owner.id, { accessToken: 'ghu_owner', refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null });
  gh = fakeGitHub(API, 'acme', 'web', { sha: BASE, files: { 'a.txt': 'a' } });
  gh.state.refs.set('autodev/AD-1-x', BASE);
  server.use(...gh.handlers);
});

async function pushedTask(daysAgo: number) {
  const [t] = await sys.db
    .insert(schema.tasks)
    .values({ orgId: fx.org.id, repoId: fx.repo.id, number: 1, key: 'AD-1', title: 'x', mode: 'direct', branchMode: 'new', workBranch: 'autodev/AD-1-x', ownerId: fx.owner.id, status: 'pushed', createPrOnCompletion: false, lastPushedAt: new Date(Date.now() - daysAgo * DAY) })
    .returning();
  await sys.db.insert(schema.workspaces).values({ orgId: fx.org.id, taskId: t!.id, repoId: fx.repo.id, baseSha: BASE, baseRef: 'main' });
  return t!;
}

describe('stale-branch sweep', () => {
  it('leaves fresh branches alone, and notifies the owner once by default', async () => {
    await pushedTask(1);
    expect(await sweepStaleBranches({ sys: sys.db, publisher })).toEqual({ checked: 0, opened: 0, notified: 0 });

    await sys.db.update(schema.tasks).set({ lastPushedAt: new Date(Date.now() - 4 * DAY) });
    expect(await sweepStaleBranches({ sys: sys.db, publisher })).toMatchObject({ checked: 1, notified: 1 });
    expect(await sweepStaleBranches({ sys: sys.db, publisher })).toMatchObject({ notified: 0 });
    const notes = await sys.db.select().from(schema.notifications).where(eq(schema.notifications.type, 'branch.stale'));
    expect(notes).toHaveLength(1);
  });

  it('tells admins about every stale branch it finds', async () => {
    const t = await pushedTask(4);
    const found: unknown[] = [];
    await sweepStaleBranches({ sys: sys.db, publisher, onStale: async (b) => void found.push(b) });
    expect(found).toEqual([{ orgId: fx.org.id, taskId: t.id, repoId: fx.repo.id, days: 3 }]);
  });

  it("auto-opens the PR as the owner when the org says so", async () => {
    await sys.db.update(schema.orgs).set({ staleBranchAction: 'auto_open_pr', staleBranchDays: 2 });
    const t = await pushedTask(3);
    expect(await sweepStaleBranches({ sys: sys.db, publisher })).toMatchObject({ opened: 1 });
    expect(gh.state.pulls[0]).toMatchObject({ head: 'autodev/AD-1-x', author: 'ghu_owner' });
    const [row] = await sys.db.select().from(schema.pullRequests);
    expect(row!.createdBy).toBe('stale_job');
    expect((await sys.db.select().from(schema.tasks).where(eq(schema.tasks.id, t.id)))[0]!.status).toBe('pr_open');
  });

  it('falls back to a notification when the PR cannot be opened', async () => {
    await sys.db.update(schema.orgs).set({ staleBranchAction: 'auto_open_pr' });
    gh.state.permission = 'pull';
    await pushedTask(5);
    expect(await sweepStaleBranches({ sys: sys.db, publisher })).toMatchObject({ opened: 0, notified: 1 });
  });
});
