import { and, eq, gte, lt, schema, sql, type LeaderboardPeriod, type LeaderboardScope, type SystemDb } from '@autodev/db';

const { leaderboardSnapshots, orgs, teamMembers, userMetricsDaily } = schema;

/**
 * Insights (B-4), run nightly and on demand:
 *  1. Rebuild `user_metrics_daily` for recent days (the last 3, so late events such as merge
 *     webhooks count; the last 90 the first time an org is seen). Delete-and-insert, so re-runs are safe.
 *  2. Rebuild the leaderboards for the current and previous week, month and quarter.
 * All days and periods are UTC. Weeks start on Monday.
 */

export const RECENT_DAYS = 3;
export const BACKFILL_DAYS = 90;
/** The approval rate used for someone with no reviewed plans or designs in the period. */
export const NEUTRAL_APPROVAL_RATE = 0.75;
export const BADGES = ['first_merge', 'ten_merged', 'clean_first_pass', 'efficient'] as const;
export type Badge = (typeof BADGES)[number];

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** The period containing `at`, moved back `offset` periods. `end` is exclusive. */
export function periodRange(period: LeaderboardPeriod, at: Date, offset = 0): { start: string; end: string } {
  const d = utcDay(at);
  let start: Date;
  let end: Date;
  if (period === 'week') {
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY);
    start = new Date(monday.getTime() - offset * 7 * DAY);
    end = new Date(start.getTime() + 7 * DAY);
  } else {
    const months = period === 'month' ? 1 : 3;
    const first = period === 'month' ? d.getUTCMonth() : Math.floor(d.getUTCMonth() / 3) * 3;
    start = new Date(Date.UTC(d.getUTCFullYear(), first - offset * months, 1));
    end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1));
  }
  return { start: isoDay(start), end: isoDay(end) };
}

/** One person's totals for a board. */
export interface Contribution {
  userId: string;
  prsMerged: number;
  docsReviewed: number;
  docsFirstPass: number;
  costUsd: number;
  tokens: number;
}

export interface Ranked extends Contribution {
  rank: number;
  impactScore: number;
  approvalRate: number | null;
  costPerPrUsd: number | null;
}

/**
 * Impact = merged PRs × (0.5 + 0.5 × first-pass approval rate). Ties go to the lower cost per merged
 * PR; the user id keeps any remaining tie in a stable order.
 */
export function rankBoard(rows: Contribution[]): Ranked[] {
  const scored = rows.map((r) => {
    const approvalRate = r.docsReviewed > 0 ? r.docsFirstPass / r.docsReviewed : null;
    const impactScore = r.prsMerged * (0.5 + 0.5 * (approvalRate ?? NEUTRAL_APPROVAL_RATE));
    const costPerPrUsd = r.prsMerged > 0 ? r.costUsd / r.prsMerged : null;
    return { ...r, approvalRate, impactScore, costPerPrUsd, rank: 0 };
  });
  scored.sort(
    (a, b) =>
      b.impactScore - a.impactScore ||
      (a.costPerPrUsd ?? Infinity) - (b.costPerPrUsd ?? Infinity) ||
      a.userId.localeCompare(b.userId),
  );
  scored.forEach((r, i) => (r.rank = i + 1));
  return scored;
}

/** Per-person facts behind the all-time badges, as of the end of a period. */
export interface BadgeFacts {
  firstMergeDay: string | null;
  mergedThroughEnd: number;
  /** Outcomes of the person's last 5 reviewed v1 plans/designs before the period end, newest first. */
  lastFiveFirstPass: boolean[];
}

export function badgesFor(r: Ranked, facts: BadgeFacts | undefined, range: { start: string; end: string }, efficientUserId: string | null): Badge[] {
  const out: Badge[] = [];
  if (facts?.firstMergeDay && facts.firstMergeDay >= range.start && facts.firstMergeDay < range.end) out.push('first_merge');
  if ((facts?.mergedThroughEnd ?? 0) >= 10) out.push('ten_merged');
  if (facts && facts.lastFiveFirstPass.length === 5 && facts.lastFiveFirstPass.every(Boolean)) out.push('clean_first_pass');
  if (efficientUserId === r.userId) out.push('efficient');
  return out;
}

/** Lowest cost per merged PR among people with at least 3 merged PRs. */
export function mostEfficient(rows: Ranked[]): string | null {
  const eligible = rows.filter((r) => r.prsMerged >= 3 && r.costPerPrUsd !== null);
  if (eligible.length === 0) return null;
  return eligible.reduce((best, r) => (r.costPerPrUsd! < best.costPerPrUsd! ? r : best)).userId;
}

/** Rebuilds `user_metrics_daily` for days in [from, to). */
export async function rollup(sys: SystemDb, orgId: string, from: string, to: string) {
  await sys.transaction(async (tx) => {
    await tx.delete(userMetricsDaily).where(and(eq(userMetricsDaily.orgId, orgId), gte(userMetricsDaily.day, from), lt(userMetricsDaily.day, to)));
    const f = sql`${from}::date`;
    const t = sql`${to}::date`;
    await tx.execute(sql`
      WITH x AS (
        SELECT (u.created_at AT TIME ZONE 'UTC')::date AS day, u.user_id, u.repo_id,
               u.cost_usd AS cost, u.input_tokens AS inp, u.output_tokens AS outp, u.cache_read_tokens AS cr,
               (u.cache_write_5m_tokens + u.cache_write_1h_tokens) AS cw, 1 AS calls,
               0 AS tc, 0 AS tr, 0 AS pm, 0 AS dr, 0 AS dfp, NULL::int AS mm, 0 AS pss, 0 AS psc
          FROM token_usage u
         WHERE u.org_id = ${orgId} AND u.created_at >= ${f} AND u.created_at < ${t}
        UNION ALL
        SELECT (k.created_at AT TIME ZONE 'UTC')::date, k.owner_id, k.repo_id, 0, 0, 0, 0, 0, 0,
               1, 0, 0, 0, 0, NULL, coalesce(k.prompt_score, 0), (k.prompt_score IS NOT NULL)::int
          FROM tasks k
         WHERE k.org_id = ${orgId} AND k.created_at >= ${f} AND k.created_at < ${t}
        UNION ALL
        SELECT (k.completed_at AT TIME ZONE 'UTC')::date, k.owner_id, k.repo_id, 0, 0, 0, 0, 0, 0,
               0, 1, 0, 0, 0, NULL, 0, 0
          FROM tasks k
         WHERE k.org_id = ${orgId} AND k.status = 'resolved' AND k.completed_at >= ${f} AND k.completed_at < ${t}
        UNION ALL
        SELECT (p.merged_at AT TIME ZONE 'UTC')::date, k.owner_id, p.repo_id, 0, 0, 0, 0, 0, 0,
               0, 0, 1, 0, 0, greatest(0, round(extract(epoch FROM p.merged_at - k.created_at) / 60))::int, 0, 0
          FROM pull_requests p JOIN tasks k ON k.id = p.task_id
         WHERE p.org_id = ${orgId} AND p.merged_at >= ${f} AND p.merged_at < ${t}
        UNION ALL
        SELECT (d.reviewed_at AT TIME ZONE 'UTC')::date, k.owner_id, k.repo_id, 0, 0, 0, 0, 0, 0,
               0, 0, 0, 1, (d.status = 'approved')::int, NULL, 0, 0
          FROM task_documents d JOIN tasks k ON k.id = d.task_id
         WHERE d.org_id = ${orgId} AND d.version = 1 AND d.reviewed_at >= ${f} AND d.reviewed_at < ${t}
      )
      INSERT INTO user_metrics_daily
        (id, org_id, day, user_id, repo_id, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         llm_calls, tasks_created, tasks_resolved, prs_merged, docs_reviewed, docs_first_pass, merge_minutes,
         prompt_score_sum, prompt_score_count)
      SELECT gen_random_uuid(), ${orgId}, day, user_id, repo_id, sum(cost), sum(inp), sum(outp), sum(cr), sum(cw),
             sum(calls)::int, sum(tc)::int, sum(tr)::int, sum(pm)::int, sum(dr)::int, sum(dfp)::int,
             coalesce(array_agg(mm) FILTER (WHERE mm IS NOT NULL), '{}'), sum(pss)::int, sum(psc)::int
        FROM x
       GROUP BY day, user_id, repo_id`);
  });
}

type Row = { user_id: string; repo_id: string | null; prs: number; reviewed: number; first_pass: number; cost: string; tokens: string };

const add = (into: Map<string, Contribution>, r: Row) => {
  const c = into.get(r.user_id) ?? { userId: r.user_id, prsMerged: 0, docsReviewed: 0, docsFirstPass: 0, costUsd: 0, tokens: 0 };
  c.prsMerged += Number(r.prs);
  c.docsReviewed += Number(r.reviewed);
  c.docsFirstPass += Number(r.first_pass);
  c.costUsd += Number(r.cost);
  c.tokens += Number(r.tokens);
  into.set(r.user_id, c);
};
const active = (c: Contribution) => c.prsMerged > 0 || c.tokens > 0 || c.docsReviewed > 0;

/** Rebuilds every board (org, each team, each repo) for one period. */
export async function snapshot(sys: SystemDb, orgId: string, period: LeaderboardPeriod, range: { start: string; end: string }, now = new Date()) {
  const rows = (await sys.execute(sql`
    SELECT m.user_id, m.repo_id, sum(m.prs_merged) AS prs, sum(m.docs_reviewed) AS reviewed, sum(m.docs_first_pass) AS first_pass,
           sum(m.cost_usd) AS cost, sum(m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_write_tokens) AS tokens
      FROM user_metrics_daily m
      JOIN org_members om ON om.org_id = m.org_id AND om.user_id = m.user_id AND om.status = 'active'
     WHERE m.org_id = ${orgId} AND m.day >= ${range.start}::date AND m.day < ${range.end}::date
     GROUP BY m.user_id, m.repo_id`)) as unknown as Row[];

  const boards: { scope: LeaderboardScope; scopeId: string | null; people: Map<string, Contribution> }[] = [];
  const org = new Map<string, Contribution>();
  const byRepo = new Map<string, Map<string, Contribution>>();
  for (const r of rows) {
    add(org, r);
    if (r.repo_id) {
      if (!byRepo.has(r.repo_id)) byRepo.set(r.repo_id, new Map());
      add(byRepo.get(r.repo_id)!, r);
    }
  }
  boards.push({ scope: 'org', scopeId: null, people: org });
  for (const [repoId, people] of byRepo) boards.push({ scope: 'repo', scopeId: repoId, people });
  const memberships = await sys.select({ teamId: teamMembers.teamId, userId: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.orgId, orgId));
  const teams = new Map<string, Map<string, Contribution>>();
  for (const m of memberships) {
    const c = org.get(m.userId);
    if (!c) continue;
    if (!teams.has(m.teamId)) teams.set(m.teamId, new Map());
    teams.get(m.teamId)!.set(m.userId, c);
  }
  for (const [teamId, people] of teams) boards.push({ scope: 'team', scopeId: teamId, people });

  const facts = await badgeFacts(sys, orgId, range.end);
  const values: (typeof leaderboardSnapshots.$inferInsert)[] = [];
  for (const b of boards) {
    const ranked = rankBoard([...b.people.values()].filter(active));
    const efficient = mostEfficient(ranked);
    for (const r of ranked) {
      values.push({
        orgId,
        period,
        periodStart: range.start,
        scope: b.scope,
        scopeId: b.scopeId,
        userId: r.userId,
        rank: r.rank,
        impactScore: r.impactScore.toFixed(4),
        prsMerged: r.prsMerged,
        approvalRate: r.approvalRate === null ? null : r.approvalRate.toFixed(4),
        costUsd: r.costUsd.toFixed(6),
        costPerPrUsd: r.costPerPrUsd === null ? null : r.costPerPrUsd.toFixed(6),
        tokens: r.tokens,
        badges: badgesFor(r, facts.get(r.userId), range, efficient),
        computedAt: now,
      });
    }
  }
  await sys.transaction(async (tx) => {
    await tx
      .delete(leaderboardSnapshots)
      .where(and(eq(leaderboardSnapshots.orgId, orgId), eq(leaderboardSnapshots.period, period), eq(leaderboardSnapshots.periodStart, range.start)));
    for (let i = 0; i < values.length; i += 500) await tx.insert(leaderboardSnapshots).values(values.slice(i, i + 500));
  });
  return values.length;
}

async function badgeFacts(sys: SystemDb, orgId: string, end: string): Promise<Map<string, BadgeFacts>> {
  const merges = (await sys.execute(sql`
    SELECT user_id, min(day) FILTER (WHERE prs_merged > 0)::text AS first_day, sum(prs_merged)::int AS merged
      FROM user_metrics_daily
     WHERE org_id = ${orgId} AND user_id IS NOT NULL AND day < ${end}::date
     GROUP BY user_id`)) as unknown as { user_id: string; first_day: string | null; merged: number }[];
  const reviews = (await sys.execute(sql`
    SELECT owner_id, approved FROM (
      SELECT k.owner_id, d.status = 'approved' AS approved,
             row_number() OVER (PARTITION BY k.owner_id ORDER BY d.reviewed_at DESC) AS n
        FROM task_documents d JOIN tasks k ON k.id = d.task_id
       WHERE d.org_id = ${orgId} AND d.version = 1 AND d.reviewed_at IS NOT NULL AND d.reviewed_at < ${end}::date
    ) r WHERE n <= 5`)) as unknown as { owner_id: string; approved: boolean }[];
  const out = new Map<string, BadgeFacts>();
  for (const m of merges) out.set(m.user_id, { firstMergeDay: m.first_day, mergedThroughEnd: Number(m.merged), lastFiveFirstPass: [] });
  for (const r of reviews) {
    const f = out.get(r.owner_id) ?? { firstMergeDay: null, mergedThroughEnd: 0, lastFiveFirstPass: [] };
    f.lastFiveFirstPass.push(r.approved);
    out.set(r.owner_id, f);
  }
  return out;
}

/** The whole job for one org: rollups, then the boards for the current and previous periods. */
export async function runInsightsForOrg(sys: SystemDb, orgId: string, now = new Date()) {
  const [any] = await sys.select({ id: userMetricsDaily.id }).from(userMetricsDaily).where(eq(userMetricsDaily.orgId, orgId)).limit(1);
  const today = utcDay(now);
  const from = isoDay(new Date(today.getTime() - ((any ? RECENT_DAYS : BACKFILL_DAYS) - 1) * DAY));
  const to = isoDay(new Date(today.getTime() + DAY));
  await rollup(sys, orgId, from, to);
  let rows = 0;
  for (const period of ['week', 'month', 'quarter'] as const) {
    for (const offset of [0, 1]) rows += await snapshot(sys, orgId, period, periodRange(period, now, offset), now);
  }
  await sys
    .update(orgs)
    .set({ settings: sql`${orgs.settings} || ${JSON.stringify({ insightsComputedAt: now.toISOString() })}::jsonb` })
    .where(eq(orgs.id, orgId));
  return { from, to, rows };
}

/** Nightly: every org. On demand (an admin's Recompute): one org. */
export async function runInsights(sys: SystemDb, opts: { orgId?: string; now?: Date } = {}) {
  const targets = opts.orgId ? [{ id: opts.orgId }] : await sys.select({ id: orgs.id }).from(orgs);
  const results: Record<string, unknown> = {};
  for (const o of targets) results[o.id] = await runInsightsForOrg(sys, o.id, opts.now);
  return results;
}

