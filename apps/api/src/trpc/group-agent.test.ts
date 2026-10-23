import { eq, schema } from '@autodev/db';
import { makeOrg, truncateAll } from '@autodev/db/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, callerFor, createTestDeps } from '../../test/harness';

const h = createTestDeps();
const { deps } = h;
afterAll(() => h.close());

let fx: Awaited<ReturnType<typeof makeOrg>>;
let admin: { id: string };
let dev: { id: string };
let vulnRec: string;
let spendRec: string;

const as = (u: { id: string }) => callerFor(deps, u.id, fx.org.id);
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);

/** Lets `userId` push to the repo, with the access cache marked fresh so no GitHub call is made. */
async function canPush(userId: string) {
  await deps.sys.insert(schema.userRepoAccess).values({ userId, repoId: fx.repo.id, orgId: fx.org.id, permission: 'push', fetchedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) });
  await deps.cache.set(`repo-access:fresh:${fx.org.id}:0:${userId}`, '1', 3600);
}

async function finding(o: { kind: 'vulnerable_dependency' | 'unusual_spend'; severity: 'high' | 'medium'; repoId: string | null; title: string; fixKind: string }) {
  const [f] = await deps.sys
    .insert(schema.groupAgentFindings)
    .values({ orgId: fx.org.id, repoId: o.repoId, kind: o.kind, severity: o.severity, fingerprint: o.title, title: o.title, details: o.repoId ? {} : { who: 'user' } })
    .returning();
  const [r] = await deps.sys
    .insert(schema.recommendations)
    .values({ orgId: fx.org.id, findingId: f!.id, repoId: o.repoId, title: `Fix: ${o.title}`, bodyMd: `About ${o.title}.`, fixKind: o.fixKind })
    .returning();
  return r!.id;
}

beforeEach(async () => {
  await truncateAll(deps.sys);
  h.groupAgentJobs.length = 0;
  fx = await makeOrg(deps.sys, 'acme');
  admin = await addMember(deps, fx.org.id, 'admin', 'admin');
  dev = await addMember(deps, fx.org.id, 'dev', 'developer');
  vulnRec = await finding({ kind: 'vulnerable_dependency', severity: 'high', repoId: fx.repo.id, title: 'lodash 4.17.20 has CVE-2021-23337', fixKind: 'dependency_bump' });
  spendRec = await finding({ kind: 'unusual_spend', severity: 'medium', repoId: null, title: 'dev spent $40', fixKind: 'investigate' });
});

describe('group agent', () => {
  it('is for admins only', async () => {
    expect(await code(as(dev).groupAgent.overview())).toBe('FORBIDDEN');
    expect(await code(as(dev).groupAgent.recommendations({}))).toBe('FORBIDDEN');
    expect(await code(as(dev).groupAgent.scanNow())).toBe('FORBIDDEN');
    expect(await code(as(dev).groupAgent.policies.update({ enabled: true }))).toBe('FORBIDDEN');
  });

  it('shows health per repo and open findings by severity, worst first', async () => {
    const o = await as(admin).groupAgent.overview();
    expect(o).toMatchObject({ enabled: false, lastScan: null, bySeverity: { critical: 0, high: 1, medium: 1, low: 0 } });
    expect(o.repos).toEqual([{ repoId: fx.repo.id, name: 'acme/web', score: 85, open: 1 }]);
    const recs = await as(admin).groupAgent.recommendations({});
    expect(recs.map((r) => [r.severity, r.repo])).toEqual([
      ['high', 'acme/web'],
      ['medium', null],
    ]);
    expect(await as(admin).groupAgent.recommendations({ kind: 'unusual_spend' })).toHaveLength(1);
  });

  it('dismisses with a reason (audited) and can reopen', async () => {
    await as(admin).groupAgent.dismiss({ id: spendRec, reason: 'Load test, expected' });
    expect(await as(admin).groupAgent.recommendations({ status: 'dismissed' })).toEqual([expect.objectContaining({ id: spendRec, dismissedReason: 'Load test, expected' })]);
    await as(admin).groupAgent.reopen({ id: spendRec });
    expect((await as(admin).groupAgent.recommendations({})).map((r) => r.id)).toContain(spendRec);
    const actions = (await deps.sys.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, fx.org.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['recommendation.dismissed', 'recommendation.reopened']));
  });

  it('turns a recommendation into a draft task, once, for an admin who can push to the repo', async () => {
    await deps.cache.set(`repo-access:fresh:${fx.org.id}:0:${admin.id}`, '1', 3600); // known: no access
    expect(await code(as(admin).groupAgent.createTask({ id: vulnRec }))).toBe('FORBIDDEN');
    await canPush(admin.id);
    const { key } = await as(admin).groupAgent.createTask({ id: vulnRec });
    const [t] = await deps.sys.select().from(schema.tasks).where(eq(schema.tasks.key, key));
    expect(t).toMatchObject({ status: 'draft', ownerId: admin.id, repoId: fx.repo.id, title: 'Fix: lodash 4.17.20 has CVE-2021-23337' });
    expect(t!.descriptionMd).toContain('From a Group Agent recommendation');
    expect(await as(admin).groupAgent.recommendations({ status: 'task_created' })).toEqual([expect.objectContaining({ id: vulnRec, taskKey: key })]);
    expect(await code(as(admin).groupAgent.createTask({ id: vulnRec }))).toBe('CONFLICT');
    expect(await code(as(admin).groupAgent.createTask({ id: spendRec }))).toBe('BAD_REQUEST');

    // Reopenable only once its task is dropped.
    expect(await code(as(admin).groupAgent.reopen({ id: vulnRec }))).toBe('BAD_REQUEST');
    await deps.sys.update(schema.tasks).set({ status: 'cancelled' }).where(eq(schema.tasks.key, key));
    await as(admin).groupAgent.reopen({ id: vulnRec });
    expect((await as(admin).groupAgent.recommendations({})).find((r) => r.id === vulnRec)).toMatchObject({ status: 'open', taskKey: null });
  });

  it('queues a scan on request, one per org', async () => {
    await as(admin).groupAgent.scanNow();
    expect(h.groupAgentJobs).toEqual([{ name: 'scan', data: { kind: 'scan', orgId: fx.org.id }, jobId: `scan-${fx.org.id}` }]);
  });

  it('returns the latest digest, marking top risks resolved since', async () => {
    expect(await as(admin).groupAgent.digest()).toBeNull();
    const [f] = await deps.sys.select().from(schema.groupAgentFindings).where(eq(schema.groupAgentFindings.kind, 'vulnerable_dependency'));
    await deps.sys.insert(schema.groupAgentRuns).values({
      orgId: fx.org.id,
      kind: 'digest',
      status: 'succeeded',
      payload: { since: new Date().toISOString(), repos: [{ repoId: fx.repo.id, name: 'acme/web', score: 85, previous: 100 }], topRisks: [{ id: f!.id, title: f!.title, severity: 'high', kind: f!.kind, repoId: fx.repo.id }], newFindings: 2, resolvedFindings: 0, openFindings: 2 },
    });
    await deps.sys.update(schema.groupAgentFindings).set({ resolvedAt: new Date() }).where(eq(schema.groupAgentFindings.id, f!.id));
    const d = await as(admin).groupAgent.digest();
    expect(d).toMatchObject({ newFindings: 2, repos: [{ name: 'acme/web', score: 85, previous: 100 }], topRisks: [{ title: f!.title, resolvedSince: true }] });
  });

  it('saves settings: on/off, budget, PR cap, and per repo scan, safety level and a maintainer with push access', async () => {
    await as(admin).groupAgent.policies.update({ enabled: true, monthlyBudgetUsd: 50, weeklyPrCap: 3 });
    expect(await code(as(admin).groupAgent.policies.updateRepo({ repoId: fx.repo.id, maintainerUserId: dev.id }))).toBe('BAD_REQUEST');
    await canPush(dev.id);
    await as(admin).groupAgent.policies.updateRepo({ repoId: fx.repo.id, safetyLevel: 1, maintainerUserId: dev.id });
    const p = await as(admin).groupAgent.policies.get();
    expect(p).toMatchObject({ enabled: true, monthlyBudgetUsd: 50, weeklyPrCap: 3 });
    expect(p.repos).toEqual([expect.objectContaining({ name: 'acme/web', scan: true, safetyLevel: 1, maintainerUserId: dev.id, candidates: [{ userId: dev.id, login: 'dev' }] })]);
    await as(admin).groupAgent.policies.updateRepo({ repoId: fx.repo.id, scan: false });
    expect((await as(admin).groupAgent.policies.get()).repos[0]).toMatchObject({ scan: false, safetyLevel: 1 });
    expect((await as(admin).groupAgent.overview()).enabled).toBe(true);
  });
});
