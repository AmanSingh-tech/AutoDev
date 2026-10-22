import { createSystemDb, eq, schema } from '@autodev/db';
import { makeOrg, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { badgesFor, mostEfficient, periodRange, rankBoard, runInsightsForOrg, type Contribution } from './insights';

const sys = createSystemDb(TEST_SYSTEM_URL);
afterAll(() => sys.close());

describe('periodRange', () => {
  const wed = new Date('2026-10-21T15:00:00Z'); // a Wednesday
  it('weeks start on Monday, months and quarters on the 1st; end is exclusive', () => {
    expect(periodRange('week', wed)).toEqual({ start: '2026-10-19', end: '2026-10-26' });
    expect(periodRange('week', wed, 1)).toEqual({ start: '2026-10-12', end: '2026-10-19' });
    expect(periodRange('month', wed)).toEqual({ start: '2026-10-01', end: '2026-11-01' });
    expect(periodRange('month', new Date('2026-01-15T00:00:00Z'), 1)).toEqual({ start: '2025-12-01', end: '2026-01-01' });
    expect(periodRange('quarter', wed)).toEqual({ start: '2026-10-01', end: '2027-01-01' });
    expect(periodRange('quarter', wed, 1)).toEqual({ start: '2026-07-01', end: '2026-10-01' });
    expect(periodRange('week', new Date('2026-10-25T23:59:00Z'))).toEqual({ start: '2026-10-19', end: '2026-10-26' }); // Sunday
  });
});

const person = (userId: string, c: Partial<Contribution>): Contribution => ({ userId, prsMerged: 0, docsReviewed: 0, docsFirstPass: 0, costUsd: 0, tokens: 0, ...c });

describe('rankBoard', () => {
  it('ranks by merged PRs weighted by first-pass approval, with a neutral rate when nothing was reviewed', () => {
    const ranked = rankBoard([
      person('a', { prsMerged: 4, docsReviewed: 4, docsFirstPass: 0 }), // 4 × 0.5 = 2
      person('b', { prsMerged: 3, docsReviewed: 3, docsFirstPass: 3 }), // 3 × 1.0 = 3
      person('c', { prsMerged: 3 }), // 3 × 0.875 = 2.625
      person('d', { tokens: 1_000_000 }), // 0
    ]);
    expect(ranked.map((r) => [r.userId, r.rank, r.impactScore])).toEqual([
      ['b', 1, 3],
      ['c', 2, 2.625],
      ['a', 3, 2],
      ['d', 4, 0],
    ]);
    expect(ranked.find((r) => r.userId === 'c')!.approvalRate).toBeNull();
    expect(ranked.find((r) => r.userId === 'd')!.costPerPrUsd).toBeNull();
  });

  it('breaks ties on the lower cost per merged PR', () => {
    const ranked = rankBoard([person('pricey', { prsMerged: 2, costUsd: 30 }), person('frugal', { prsMerged: 2, costUsd: 10 })]);
    expect(ranked.map((r) => r.userId)).toEqual(['frugal', 'pricey']);
    expect(ranked[0]!.costPerPrUsd).toBe(5);
  });
});

describe('badges', () => {
  const range = { start: '2026-10-01', end: '2026-11-01' };
  const ranked = rankBoard([person('a', { prsMerged: 3, costUsd: 3 }), person('b', { prsMerged: 5, costUsd: 50 }), person('c', { prsMerged: 1, costUsd: 0.1 })]);
  it('efficient goes to the lowest cost per PR among people with at least 3 merged PRs', () => {
    expect(mostEfficient(ranked)).toBe('a');
  });
  it('first merge in the period, 10 merged PRs all time, and 5 first-pass approvals in a row', () => {
    const a = ranked.find((r) => r.userId === 'a')!;
    expect(badgesFor(a, { firstMergeDay: '2026-10-03', mergedThroughEnd: 12, lastFiveFirstPass: [true, true, true, true, true] }, range, 'a')).toEqual([
      'first_merge',
      'ten_merged',
      'clean_first_pass',
      'efficient',
    ]);
    expect(badgesFor(a, { firstMergeDay: '2026-09-03', mergedThroughEnd: 9, lastFiveFirstPass: [true, true, true, true, false] }, range, 'b')).toEqual([]);
    expect(badgesFor(a, { firstMergeDay: null, mergedThroughEnd: 0, lastFiveFirstPass: [true, true, true, true] }, range, null)).toEqual([]);
  });
});

describe('runInsightsForOrg', () => {
  let fx: Awaited<ReturnType<typeof makeOrg>>;
  let dev: { id: string };
  let gone: { id: string };
  const now = new Date();
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  let n = 0;

  beforeEach(async () => {
    await truncateAll(sys.db);
    fx = await makeOrg(sys.db, 'acme');
    const [d, g] = await sys.db
      .insert(schema.users)
      .values([
        { githubUserId: 9_400_001, githubLogin: 'dev' },
        { githubUserId: 9_400_002, githubLogin: 'gone' },
      ])
      .returning();
    dev = d!;
    gone = g!;
    await sys.db.insert(schema.orgMembers).values([
      { orgId: fx.org.id, userId: dev.id, role: 'developer' },
      { orgId: fx.org.id, userId: gone.id, role: 'developer', status: 'removed' },
    ]);
  });

  /** A task owned by `owner`, created `createdHoursAgo`, optionally merged and with a reviewed plan v1. */
  async function task(owner: string, o: { createdHoursAgo: number; mergedHoursAgo?: number; planApproved?: boolean; score?: number }) {
    n++;
    const [t] = await sys.db
      .insert(schema.tasks)
      .values({
        orgId: fx.org.id,
        repoId: fx.repo.id,
        number: n,
        key: `AD-${n}`,
        title: 't',
        mode: 'plan_only',
        branchMode: 'new',
        workBranch: `autodev/AD-${n}`,
        ownerId: owner,
        status: o.mergedHoursAgo === undefined ? 'coding' : 'resolved',
        completedAt: o.mergedHoursAgo === undefined ? null : hoursAgo(o.mergedHoursAgo),
        promptScore: o.score ?? null,
        createdAt: hoursAgo(o.createdHoursAgo),
      })
      .returning();
    if (o.mergedHoursAgo !== undefined)
      await sys.db.insert(schema.pullRequests).values({
        orgId: fx.org.id,
        taskId: t!.id,
        repoId: fx.repo.id,
        githubPrId: 9_000 + n,
        number: n,
        url: `https://github.test/pr/${n}`,
        headBranch: `autodev/AD-${n}`,
        baseBranch: 'main',
        state: 'merged',
        createdBy: 'agent_on_completion',
        mergedAt: hoursAgo(o.mergedHoursAgo),
      });
    if (o.planApproved !== undefined)
      await sys.db.insert(schema.taskDocuments).values({
        orgId: fx.org.id,
        taskId: t!.id,
        kind: 'plan',
        version: 1,
        contentMd: 'plan',
        status: o.planApproved ? 'approved' : 'changes_requested',
        reviewedAt: hoursAgo(o.createdHoursAgo / 2),
      });
    return t!;
  }

  const usage = (userId: string, cost: string, tokens: number) =>
    sys.db.insert(schema.tokenUsage).values({ id: randomUUID(), orgId: fx.org.id, userId, repoId: fx.repo.id, provider: 'anthropic', model: 'claude-opus-5-5', useCase: 'agent', inputTokens: tokens, outputTokens: 0, costUsd: cost });

  it('rolls up cost, tasks, merges, first-pass reviews, time to merge and prompt scores per person and repo', async () => {
    await task(fx.owner.id, { createdHoursAgo: 0.5, mergedHoursAgo: 0.1, planApproved: true, score: 80 });
    await task(fx.owner.id, { createdHoursAgo: 0.4, planApproved: false, score: 60 });
    await usage(fx.owner.id, '1.500000', 1000);
    await usage(fx.owner.id, '0.500000', 500);

    await runInsightsForOrg(sys.db, fx.org.id, now);

    const rows = await sys.db.select().from(schema.userMetricsDaily).where(eq(schema.userMetricsDaily.userId, fx.owner.id));
    const total = rows.reduce(
      (s, r) => ({
        cost: s.cost + Number(r.costUsd),
        tokens: s.tokens + r.inputTokens,
        calls: s.calls + r.llmCalls,
        created: s.created + r.tasksCreated,
        resolved: s.resolved + r.tasksResolved,
        merged: s.merged + r.prsMerged,
        reviewed: s.reviewed + r.docsReviewed,
        firstPass: s.firstPass + r.docsFirstPass,
        minutes: [...s.minutes, ...r.mergeMinutes],
        scoreSum: s.scoreSum + r.promptScoreSum,
        scored: s.scored + r.promptScoreCount,
      }),
      { cost: 0, tokens: 0, calls: 0, created: 0, resolved: 0, merged: 0, reviewed: 0, firstPass: 0, minutes: [] as number[], scoreSum: 0, scored: 0 },
    );
    expect(total).toEqual({ cost: 2, tokens: 1500, calls: 2, created: 2, resolved: 1, merged: 1, reviewed: 2, firstPass: 1, minutes: [24], scoreSum: 140, scored: 2 });
  });

  it('builds org, repo and team boards for the current and previous periods, for active members only', async () => {
    const [team] = await sys.db.insert(schema.teams).values({ orgId: fx.org.id, name: 'Core', slug: 'core' }).returning();
    await sys.db.insert(schema.teamMembers).values({ orgId: fx.org.id, teamId: team!.id, userId: dev.id });
    await task(fx.owner.id, { createdHoursAgo: 0.05, mergedHoursAgo: 0.01 });
    await task(dev.id, { createdHoursAgo: 0.05, mergedHoursAgo: 0.01, planApproved: true });
    await task(dev.id, { createdHoursAgo: 0.05, mergedHoursAgo: 0.01, planApproved: true });
    await task(gone.id, { createdHoursAgo: 0.05, mergedHoursAgo: 0.01 });

    await runInsightsForOrg(sys.db, fx.org.id, now);

    const week = periodRange('week', now).start;
    const boards = await sys.db.select().from(schema.leaderboardSnapshots).where(eq(schema.leaderboardSnapshots.periodStart, week));
    const org = boards.filter((b) => b.scope === 'org' && b.period === 'week').sort((a, b) => a.rank - b.rank);
    expect(org.map((b) => [b.userId, b.rank, b.prsMerged, Number(b.impactScore)])).toEqual([
      [dev.id, 1, 2, 2],
      [fx.owner.id, 2, 1, 0.875],
    ]);
    expect(org[0]!.badges).toContain('first_merge');
    expect(boards.filter((b) => b.scope === 'repo' && b.scopeId === fx.repo.id && b.period === 'week')).toHaveLength(2);
    expect(boards.filter((b) => b.scope === 'team' && b.period === 'week').map((b) => b.userId)).toEqual([dev.id]);
    const periods = new Set((await sys.db.select().from(schema.leaderboardSnapshots)).map((b) => `${b.period}:${b.periodStart}`));
    expect(periods).toContain(`quarter:${periodRange('quarter', now).start}`);

    const [org2] = await sys.db.select().from(schema.orgs).where(eq(schema.orgs.id, fx.org.id));
    expect(typeof (org2!.settings as Record<string, unknown>).insightsComputedAt).toBe('string');
  });

  it('backfills 90 days the first time and only recent days afterwards, and re-running changes nothing', async () => {
    await task(fx.owner.id, { createdHoursAgo: 24 * 40, mergedHoursAgo: 24 * 39 });
    const first = await runInsightsForOrg(sys.db, fx.org.id, now);
    const second = await runInsightsForOrg(sys.db, fx.org.id, now);
    const day = (s: string) => Math.round((Date.parse(first.to) - Date.parse(s)) / 86_400_000);
    expect(day(first.from)).toBe(90);
    expect(day(second.from)).toBe(3);
    const rows = await sys.db.select().from(schema.userMetricsDaily);
    expect(rows.reduce((s, r) => s + r.prsMerged, 0)).toBe(1);
  });
});
