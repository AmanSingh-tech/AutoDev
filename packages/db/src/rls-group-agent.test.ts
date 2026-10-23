import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, truncateAll } from '../test/fixtures';
import { TEST_APP_URL, TEST_SYSTEM_URL } from '../test/env';
import { createAppDb, createSystemDb, withOrg } from './client';
import { agentPolicies, groupAgentFindings, groupAgentRuns, recommendations } from './schema';

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
    const [f] = await sys.db.insert(groupAgentFindings).values({ orgId: fx.org.id, repoId: fx.repo.id, kind: 'stuck_task', severity: 'medium', fingerprint: 'x', title: 'stuck' }).returning();
    await sys.db.insert(recommendations).values({ orgId: fx.org.id, findingId: f!.id, repoId: fx.repo.id, title: 'Unblock', bodyMd: 'b', fixKind: 'investigate' });
    await sys.db.insert(groupAgentRuns).values({ orgId: fx.org.id, kind: 'scan' });
  }
});

const asA = <T>(fn: Parameters<typeof withOrg<T>>[3]) => withOrg(app.db, a.org.id, a.owner.id, fn);

describe('group agent RLS', () => {
  it('shows an org only its own findings, recommendations and runs', async () => {
    const [f, r, runs] = await asA(async (tx) => [await tx.select().from(groupAgentFindings), await tx.select().from(recommendations), await tx.select().from(groupAgentRuns)]);
    expect([f.length, r.length, runs.length]).toEqual([1, 1, 1]);
    expect(f[0]!.orgId).toBe(a.org.id);
  });

  it('lets the app change a recommendation status and policies, but only the worker writes findings and runs', async () => {
    const changed = await asA((tx) => tx.update(recommendations).set({ status: 'dismissed' }).returning());
    expect(changed).toHaveLength(1);
    await asA((tx) => tx.insert(agentPolicies).values({ orgId: a.org.id, enabled: true }));
    await expect(asA((tx) => tx.insert(groupAgentFindings).values({ orgId: a.org.id, kind: 'stuck_task', severity: 'low', fingerprint: 'y', title: 't' }))).rejects.toThrow(/permission denied/);
    await expect(asA((tx) => tx.update(groupAgentRuns).set({ status: 'failed' }))).rejects.toThrow(/permission denied/);
    await expect(asA((tx) => tx.delete(recommendations))).rejects.toThrow(/permission denied/);
    await expect(asA((tx) => tx.insert(agentPolicies).values({ orgId: b.org.id, enabled: true }))).rejects.toThrow(/row-level security/);
    const [other] = await sys.db.select().from(recommendations).where(eq(recommendations.orgId, b.org.id));
    expect(other!.status).toBe('open');
  });
});
