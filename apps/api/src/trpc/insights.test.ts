import { randomUUID } from 'node:crypto';
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
let lead: { id: string };
let teamId: string;
let otherTeamId: string;

const as = (u: { id: string }) => callerFor(deps, u.id, fx.org.id);
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);

/** The Monday of this week, UTC — the API's current week start. */
function thisWeek() {
  const d = new Date();
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
  return m.toISOString().slice(0, 10);
}
const today = () => new Date().toISOString().slice(0, 10);

beforeEach(async () => {
  await truncateAll(deps.sys);
  h.insightsJobs.length = 0;
  fx = await makeOrg(deps.sys, 'acme');
  admin = await addMember(deps, fx.org.id, 'admin', 'admin');
  dev = await addMember(deps, fx.org.id, 'dev', 'developer');
  lead = await addMember(deps, fx.org.id, 'lead', 'developer');
  const [core, other] = await deps.sys
    .insert(schema.teams)
    .values([
      { orgId: fx.org.id, name: 'Core', slug: 'core' },
      { orgId: fx.org.id, name: 'Other', slug: 'other' },
    ])
    .returning();
  teamId = core!.id;
  otherTeamId = other!.id;
  await deps.sys.insert(schema.teamMembers).values([
    { orgId: fx.org.id, teamId, userId: lead.id, isLead: true },
    { orgId: fx.org.id, teamId, userId: dev.id },
  ]);

  // One week's board and its rollups: dev is first on impact, lead uses more tokens.
  const week = thisWeek();
  const board = (userId: string, rank: number, prs: number, tokens: number, scope: 'org' | 'team', scopeId: string | null) => ({
    orgId: fx.org.id,
    period: 'week' as const,
    periodStart: week,
    scope,
    scopeId,
    userId,
    rank,
    impactScore: String(prs),
    prsMerged: prs,
    approvalRate: '1.0000',
    costUsd: '12.000000',
    costPerPrUsd: String(12 / prs),
    tokens,
    badges: ['first_merge'],
  });
  await deps.sys.insert(schema.leaderboardSnapshots).values([
    board(dev.id, 1, 3, 1_000, 'org', null),
    board(lead.id, 2, 1, 9_000, 'org', null),
    board(dev.id, 1, 3, 1_000, 'team', teamId),
    board(lead.id, 2, 1, 9_000, 'team', teamId),
  ]);
  await deps.sys.insert(schema.userMetricsDaily).values([
    { orgId: fx.org.id, day: today(), userId: dev.id, repoId: fx.repo.id, costUsd: '6', inputTokens: 1000, prsMerged: 3, tasksCreated: 4, tasksResolved: 3, docsReviewed: 4, docsFirstPass: 3, mergeMinutes: [60, 120, 600], promptScoreSum: 160, promptScoreCount: 2 },
    { orgId: fx.org.id, day: today(), userId: lead.id, repoId: fx.repo.id, costUsd: '4', inputTokens: 9000, prsMerged: 1, tasksCreated: 1, mergeMinutes: [30] },
    { orgId: fx.org.id, day: today(), userId: admin.id, repoId: fx.repo.id, costUsd: '100', inputTokens: 50 },
  ]);
  await deps.sys.insert(schema.tokenUsage).values({ id: randomUUID(), orgId: fx.org.id, userId: dev.id, repoId: fx.repo.id, provider: 'anthropic', model: 'claude-opus-5-5', useCase: 'agent', inputTokens: 10, costUsd: '1.5' });
});

const board = (u: { id: string }, extra: Record<string, unknown> = {}) => as(u).insights.leaderboard({ period: 'week', ...extra });
const setVisibility = (v: 'all' | 'team_leads' | 'admins', more: Record<string, unknown> = {}) => as(admin).insights.updateSettings({ leaderboardVisibility: v, ...more });

describe('leaderboard visibility', () => {
  it('is admins-only by default; admins see cost, badges stay off until enabled', async () => {
    expect(await code(board(dev))).toBe('FORBIDDEN');
    expect(await code(board(lead, { scope: 'team', scopeId: teamId }))).toBe('FORBIDDEN');
    const b = await board(admin);
    expect(b.rows.map((r) => [r.login, r.rank, r.costUsd])).toEqual([
      ['dev', 1, 12],
      ['lead', 2, 12],
    ]);
    expect(b.rows[0]!.badges).toEqual([]);
    expect(b.costHidden).toBe(false);
  });

  it('"all" opens it to everyone, with cost hidden from non-admins by default', async () => {
    await setVisibility('all', { badgesEnabled: true });
    const b = await board(dev);
    expect(b.costHidden).toBe(true);
    expect(b.rows.every((r) => r.costUsd === null && r.costPerPrUsd === null)).toBe(true);
    expect(b.rows[0]).toMatchObject({ login: 'dev', isYou: true, badges: ['first_merge'] });
    await as(admin).insights.updateSettings({ hideCostFromNonAdmins: false });
    expect((await board(dev)).rows[0]!.costUsd).toBe(12);
  });

  it('"team_leads" lets a lead see only the teams they lead', async () => {
    await setVisibility('team_leads');
    expect(await code(board(lead))).toBe('FORBIDDEN');
    expect(await code(board(lead, { scope: 'team', scopeId: otherTeamId }))).toBe('FORBIDDEN');
    const b = await board(lead, { scope: 'team', scopeId: teamId });
    expect(b.rows).toHaveLength(2);
    expect(b.scopes).toMatchObject({ org: false, teams: [{ id: teamId, name: 'Core' }], repos: [] });
    expect(await code(board(dev, { scope: 'team', scopeId: teamId }))).toBe('FORBIDDEN');
  });

  it('the tokens tab re-ranks by tokens', async () => {
    const b = await board(admin, { tab: 'tokens' });
    expect(b.rows.map((r) => [r.login, r.rank])).toEqual([
      ['lead', 1],
      ['dev', 2],
    ]);
  });

  it('settings tell the web app what the viewer may open', async () => {
    expect(await as(dev).insights.settings()).toMatchObject({ leaderboardVisibility: 'admins', canSeeLeaderboard: false, canSeeOverview: false });
    await setVisibility('team_leads');
    expect(await as(lead).insights.settings()).toMatchObject({ canSeeLeaderboard: true, canSeeOverview: true, leadTeamIds: [teamId] });
  });
});

describe('overview', () => {
  const range = () => ({ from: today(), to: today() });

  it('gives admins the org totals: cost per merged PR, first-pass rate, median time to merge, prompt score', async () => {
    const o = await as(admin).insights.overview(range());
    expect(o.totals).toMatchObject({ costUsd: 110, prsMerged: 4, tasksCreated: 5, tasksResolved: 3, costPerMergedPrUsd: 27.5, firstPassRate: 0.75, avgPromptScore: 80 });
    expect(o.totals.medianMergeHours).toBeCloseTo(1.5); // median of 30, 60, 120, 600 minutes
    expect(o.byUser.map((u) => u.label)).toEqual(['dev', 'lead', 'admin']);
    expect(o.byTeam).toEqual([expect.objectContaining({ label: 'Core', prsMerged: 4 })]);
    expect(o.byModel).toEqual([{ model: 'claude-opus-5-5', costUsd: 1.5, tokens: 10 }]);
    expect(o.series).toHaveLength(1);
  });

  it('lets a team lead see their own team only, without cost by default', async () => {
    expect(await code(as(lead).insights.overview(range()))).toBe('FORBIDDEN');
    expect(await code(as(lead).insights.overview({ ...range(), teamId: otherTeamId }))).toBe('FORBIDDEN');
    const o = await as(lead).insights.overview({ ...range(), teamId });
    expect(o.totals).toMatchObject({ prsMerged: 4, costUsd: null, costPerMergedPrUsd: null });
    expect(o.byUser.map((u) => u.label).sort()).toEqual(['dev', 'lead']);
    expect(o.byModel).toEqual([]);
    expect(await code(as(dev).insights.overview(range()))).toBe('FORBIDDEN');
  });
});

describe('settings, recompute and team leads', () => {
  it('only admins change settings or recompute; both are audited and recompute queues one job per org', async () => {
    expect(await code(as(dev).insights.updateSettings({ badgesEnabled: true }))).toBe('FORBIDDEN');
    expect(await code(as(dev).insights.recompute())).toBe('FORBIDDEN');
    await as(admin).insights.updateSettings({ badgesEnabled: true });
    await as(admin).insights.recompute();
    expect(h.insightsJobs).toEqual([{ name: 'insights', data: { orgId: fx.org.id }, jobId: `insights-${fx.org.id}` }]);
    const actions = (await deps.sys.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, fx.org.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['insights.settings_updated', 'insights.recompute_requested']));
  });

  it('admins mark team leads; it has to be a member of that team', async () => {
    await as(admin).teams.setLead({ teamId, userId: dev.id, isLead: true });
    expect((await as(dev).teams.list()).find((t) => t.id === teamId)!.members.find((m) => m.userId === dev.id)!.isLead).toBe(true);
    expect(await code(as(admin).teams.setLead({ teamId: otherTeamId, userId: dev.id, isLead: true }))).toBe('NOT_FOUND');
    expect(await code(as(dev).teams.setLead({ teamId, userId: dev.id, isLead: false }))).toBe('FORBIDDEN');
  });
});
