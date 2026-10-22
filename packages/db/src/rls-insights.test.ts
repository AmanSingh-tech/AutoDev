import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, truncateAll } from '../test/fixtures';
import { TEST_APP_URL, TEST_SYSTEM_URL } from '../test/env';
import { createAppDb, createSystemDb, withOrg } from './client';
import { leaderboardSnapshots, userMetricsDaily } from './schema';

const sys = createSystemDb(TEST_SYSTEM_URL);
const app = createAppDb(TEST_APP_URL);
afterAll(async () => {
  await Promise.all([sys.close(), app.close()]);
});

let a: Awaited<ReturnType<typeof makeOrg>>;
let b: Awaited<ReturnType<typeof makeOrg>>;
beforeEach(async () => {
  await truncateAll(sys.db);
  a = await makeOrg(sys.db, 'acme');
  b = await makeOrg(sys.db, 'globex');
  for (const fx of [a, b]) {
    await sys.db.insert(userMetricsDaily).values({ orgId: fx.org.id, day: '2026-10-01', userId: fx.owner.id, repoId: fx.repo.id, prsMerged: 1 });
    await sys.db.insert(leaderboardSnapshots).values({ orgId: fx.org.id, period: 'week', periodStart: '2026-09-28', scope: 'org', userId: fx.owner.id, rank: 1, impactScore: '1', prsMerged: 1, costUsd: '1', tokens: 1 });
  }
});

describe('insights RLS', () => {
  it('shows an org only its own rollups and boards', async () => {
    const [m, l] = await withOrg(app.db, a.org.id, a.owner.id, async (tx) => [await tx.select().from(userMetricsDaily), await tx.select().from(leaderboardSnapshots)]);
    expect(m.map((r) => r.orgId)).toEqual([a.org.id]);
    expect(l.map((r) => r.orgId)).toEqual([a.org.id]);
  });

  it('is read-only for the app role: only the worker writes', async () => {
    await expect(withOrg(app.db, a.org.id, a.owner.id, (tx) => tx.insert(userMetricsDaily).values({ orgId: a.org.id, day: '2026-10-02' }))).rejects.toThrow(/permission denied/);
    await expect(withOrg(app.db, a.org.id, a.owner.id, (tx) => tx.update(leaderboardSnapshots).set({ rank: 9 }))).rejects.toThrow(/permission denied/);
    await expect(withOrg(app.db, a.org.id, a.owner.id, (tx) => tx.delete(userMetricsDaily))).rejects.toThrow(/permission denied/);
  });

  it('keeps one rollup row per org, day, person and repo, even when person or repo is missing', async () => {
    await sys.db.insert(userMetricsDaily).values({ orgId: a.org.id, day: '2026-10-03' });
    await expect(sys.db.insert(userMetricsDaily).values({ orgId: a.org.id, day: '2026-10-03' })).rejects.toThrow(/user_metrics_daily_uq/);
  });
});
