import { randomUUID } from 'node:crypto';
import { createSystemDb, eq, schema } from '@autodev/db';
import { makeOrg, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { proposeFixes } from './fixes';

const sys = createSystemDb(TEST_SYSTEM_URL);
afterAll(() => sys.close());

let fx: Awaited<ReturnType<typeof makeOrg>>;
let maintainer: { id: string };
let jobs: { taskId: string; jobId: string }[] = [];
const deps = { sys: sys.db, enqueueAgent: async (data: { taskId: string }, jobId: string) => void jobs.push({ taskId: data.taskId, jobId }) };

async function rec(o: { severity?: 'high' | 'low'; fixKind?: string; package?: string } = {}) {
  const pkg = o.package ?? 'lodash';
  const [f] = await sys.db
    .insert(schema.groupAgentFindings)
    .values({
      orgId: fx.org.id,
      repoId: fx.repo.id,
      kind: 'vulnerable_dependency',
      severity: o.severity ?? 'high',
      fingerprint: `vuln:${pkg}:${randomUUID()}`,
      title: `${pkg} has an advisory`,
      details: { ecosystem: 'npm', package: pkg, version: '4.17.20', fixedVersion: '4.17.21', file: 'package-lock.json', advisory: 'CVE-1' },
    })
    .returning();
  const [r] = await sys.db
    .insert(schema.recommendations)
    .values({ orgId: fx.org.id, findingId: f!.id, repoId: fx.repo.id, title: `Upgrade ${pkg} to 4.17.21 in acme/web`, bodyMd: 'Because.', fixKind: o.fixKind ?? 'dependency_bump' })
    .returning();
  return r!;
}

beforeEach(async () => {
  await truncateAll(sys.db);
  jobs = [];
  fx = await makeOrg(sys.db, 'acme');
  const [m] = await sys.db.insert(schema.users).values({ githubUserId: 9_500_001, githubLogin: 'maintainer' }).returning();
  maintainer = m!;
  await sys.db.insert(schema.orgMembers).values({ orgId: fx.org.id, userId: maintainer.id, role: 'developer' });
  await sys.db.insert(schema.userRepoAccess).values({ orgId: fx.org.id, repoId: fx.repo.id, userId: maintainer.id, permission: 'push', fetchedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) });
  await sys.db.insert(schema.agentPolicies).values([
    { orgId: fx.org.id, enabled: true, weeklyPrCap: 2, monthlyBudgetUsd: '10.00' },
    { orgId: fx.org.id, repoId: fx.repo.id, enabled: true, safetyLevel: 2, maintainerUserId: maintainer.id },
  ]);
});

describe('proposeFixes', () => {
  it('turns a safe fix into a queued direct task owned by the maintainer, flagged for the bot', async () => {
    const r = await rec();
    const result = await proposeFixes(deps, fx.org.id);
    expect(result.started).toHaveLength(1);
    const [t] = await sys.db.select().from(schema.tasks).where(eq(schema.tasks.key, result.started[0]!));
    expect(t).toMatchObject({ status: 'queued', mode: 'direct', byGroupAgent: true, ownerId: maintainer.id, createdBy: null, priority: 'high', title: 'Upgrade lodash to 4.17.21 in acme/web' });
    expect(t!.descriptionMd).toContain('Change `lodash` from 4.17.20 to 4.17.21 in `package-lock.json`');
    expect(jobs).toEqual([{ taskId: t!.id, jobId: expect.stringMatching(/^run-/) }]);
    const [after] = await sys.db.select().from(schema.recommendations).where(eq(schema.recommendations.id, r.id));
    expect(after).toMatchObject({ status: 'task_created', taskId: t!.id });

    // Running again starts nothing new.
    expect((await proposeFixes(deps, fx.org.id)).started).toEqual([]);
  });

  it('respects the weekly cap, worst severity first', async () => {
    await rec({ severity: 'low', package: 'a' });
    await rec({ severity: 'high', package: 'b' });
    await rec({ severity: 'high', package: 'c' });
    const first = await proposeFixes(deps, fx.org.id);
    expect(first.started).toHaveLength(2);
    const titles = (await sys.db.select({ title: schema.tasks.title }).from(schema.tasks)).map((t) => t.title).sort();
    expect(titles).toEqual(['Upgrade b to 4.17.21 in acme/web', 'Upgrade c to 4.17.21 in acme/web']);
    expect(await proposeFixes(deps, fx.org.id)).toEqual({ started: [], skipped: 'cap' });
  });

  it('does nothing when the agent is off, its budget is used up, or the repo only allows suggestions', async () => {
    await rec();
    await sys.db.insert(schema.tokenUsage).values({ id: randomUUID(), orgId: fx.org.id, provider: 'anthropic', model: 'm', useCase: 'group_agent', costUsd: '10.5' });
    expect(await proposeFixes(deps, fx.org.id)).toEqual({ started: [], skipped: 'budget' });

    await sys.db.update(schema.agentPolicies).set({ monthlyBudgetUsd: null });
    await sys.db.update(schema.agentPolicies).set({ safetyLevel: 1 }).where(eq(schema.agentPolicies.repoId, fx.repo.id));
    expect((await proposeFixes(deps, fx.org.id)).started).toEqual([]);

    await sys.db.update(schema.agentPolicies).set({ enabled: false });
    expect(await proposeFixes(deps, fx.org.id)).toEqual({ started: [], skipped: 'disabled' });
  });

  it('needs a maintainer who can still push, and only takes dependency bumps', async () => {
    await rec({ fixKind: 'task' });
    expect((await proposeFixes(deps, fx.org.id)).started).toEqual([]);
    await rec();
    await sys.db.delete(schema.userRepoAccess).where(eq(schema.userRepoAccess.userId, maintainer.id));
    expect((await proposeFixes(deps, fx.org.id)).started).toEqual([]);
  });
});
