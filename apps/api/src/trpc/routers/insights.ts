import { insightsJobId } from '@autodev/config';
import { and, asc, eq, insightsSettings, LEADERBOARD_PERIODS, LEADERBOARD_VISIBILITY, schema, sql, type InsightsSettings, type Tx } from '@autodev/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, orgProcedure, roleAtLeast, router } from '../trpc';

const { leaderboardSnapshots, orgs, repos, teamMembers, teams, users } = schema;

type Ctx = { orgId: string; userId: string; role: Parameters<typeof roleAtLeast>[0]; inOrg: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> };

/** Who the caller is for insights: an admin, and the teams they lead. */
async function viewer(ctx: Ctx) {
  const isAdmin = roleAtLeast(ctx.role, 'admin');
  const led = await ctx.inOrg((tx) =>
    tx.select({ teamId: teamMembers.teamId }).from(teamMembers).where(and(eq(teamMembers.orgId, ctx.orgId), eq(teamMembers.userId, ctx.userId), eq(teamMembers.isLead, true))),
  );
  const [org] = await ctx.inOrg((tx) => tx.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, ctx.orgId)));
  return { isAdmin, leadTeamIds: led.map((l) => l.teamId), settings: insightsSettings(org?.settings) };
}

/** Can this viewer open the leaderboard for this scope? Admins always can. */
function canSeeBoard(v: Awaited<ReturnType<typeof viewer>>, scope: 'org' | 'team' | 'repo', scopeId: string | undefined) {
  if (v.isAdmin) return true;
  if (v.settings.leaderboardVisibility === 'all') return true;
  if (v.settings.leaderboardVisibility === 'team_leads') return scope === 'team' && !!scopeId && v.leadTeamIds.includes(scopeId);
  return false;
}

/** The period containing today (UTC), moved back `offset` periods. Mirrors apps/worker/src/insights.ts. */
function periodRange(period: (typeof LEADERBOARD_PERIODS)[number], offset: number, at = new Date()) {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  if (period === 'week') {
    const start = new Date(d.getTime() - (((d.getUTCDay() + 6) % 7) + offset * 7) * 86_400_000);
    return { start: iso(start), end: iso(new Date(start.getTime() + 7 * 86_400_000)) };
  }
  const months = period === 'month' ? 1 : 3;
  const first = period === 'month' ? d.getUTCMonth() : Math.floor(d.getUTCMonth() / 3) * 3;
  const start = new Date(Date.UTC(d.getUTCFullYear(), first - offset * months, 1));
  return { start: iso(start), end: iso(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1))) };
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Delivery and cost figures for a set of user_metrics_daily rows (the WHERE clause decides which). */
const KPI = sql`
  coalesce(sum(m.cost_usd), 0)::float8 AS cost_usd,
  coalesce(sum(m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_write_tokens), 0)::float8 AS tokens,
  coalesce(sum(m.tasks_created), 0)::int AS tasks_created,
  coalesce(sum(m.tasks_resolved), 0)::int AS tasks_resolved,
  coalesce(sum(m.prs_merged), 0)::int AS prs_merged,
  coalesce(sum(m.docs_reviewed), 0)::int AS docs_reviewed,
  coalesce(sum(m.docs_first_pass), 0)::int AS docs_first_pass,
  (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY v) FROM unnest(array_cat_agg(m.merge_minutes)) AS v)::float8 AS median_merge_minutes,
  CASE WHEN sum(m.prompt_score_count) > 0 THEN (sum(m.prompt_score_sum)::float8 / sum(m.prompt_score_count)) END AS avg_prompt_score`;

type KpiRow = {
  cost_usd: number;
  tokens: number;
  tasks_created: number;
  tasks_resolved: number;
  prs_merged: number;
  docs_reviewed: number;
  docs_first_pass: number;
  median_merge_minutes: number | null;
  avg_prompt_score: number | null;
};

function kpis(r: KpiRow, hideCost: boolean) {
  return {
    costUsd: hideCost ? null : Number(r.cost_usd),
    tokens: Number(r.tokens),
    tasksCreated: r.tasks_created,
    tasksResolved: r.tasks_resolved,
    prsMerged: r.prs_merged,
    costPerMergedPrUsd: hideCost || r.prs_merged === 0 ? null : Number(r.cost_usd) / r.prs_merged,
    firstPassRate: r.docs_reviewed > 0 ? r.docs_first_pass / r.docs_reviewed : null,
    docsReviewed: r.docs_reviewed,
    medianMergeHours: r.median_merge_minutes === null ? null : Number(r.median_merge_minutes) / 60,
    avgPromptScore: num(r.avg_prompt_score),
  };
}

/**
 * Insights and leaderboard (B-4). Figures come from the nightly rollups (apps/worker/src/insights.ts),
 * so they lag by up to a day; `dataThrough` says when they were last rebuilt.
 */
export const insightsRouter = router({
  /** Settings plus what this viewer may open, so the web app can show the right links. */
  settings: orgProcedure.query(async ({ ctx }) => {
    const v = await viewer(ctx);
    return {
      ...v.settings,
      isAdmin: v.isAdmin,
      leadTeamIds: v.leadTeamIds,
      canSeeOverview: v.isAdmin || v.leadTeamIds.length > 0,
      canSeeLeaderboard: v.isAdmin || v.settings.leaderboardVisibility === 'all' || (v.settings.leaderboardVisibility === 'team_leads' && v.leadTeamIds.length > 0),
    };
  }),

  updateSettings: adminProcedure
    .input(
      z
        .object({ leaderboardVisibility: z.enum(LEADERBOARD_VISIBILITY), hideCostFromNonAdmins: z.boolean(), badgesEnabled: z.boolean() })
        .partial()
        .refine((v) => Object.keys(v).length > 0, 'Nothing to update'),
    )
    .mutation(({ ctx, input }) =>
      ctx.inOrg(async (tx) => {
        const [row] = await tx
          .update(orgs)
          .set({ settings: sql`${orgs.settings} || ${JSON.stringify(input)}::jsonb` })
          .where(eq(orgs.id, ctx.orgId))
          .returning({ settings: orgs.settings });
        await ctx.audit(tx, { action: 'insights.settings_updated', targetType: 'org', targetId: ctx.orgId, metadata: input });
        return insightsSettings(row!.settings) satisfies InsightsSettings;
      }),
    ),

  /** Rebuild now instead of waiting for the night. Repeated clicks share one queued run. */
  recompute: adminProcedure.mutation(async ({ ctx }) => {
    await ctx.deps.queues.insights.add('insights', { orgId: ctx.orgId }, { jobId: insightsJobId(ctx.orgId) });
    await ctx.inOrg((tx) => ctx.audit(tx, { action: 'insights.recompute_requested', targetType: 'org', targetId: ctx.orgId }));
    return { queued: true };
  }),

  /**
   * The dashboard. Admins see the whole org (or one team); team leads see only teams they lead.
   * Cost figures are hidden from non-admins when the org says so.
   */
  overview: orgProcedure
    .input(z.object({ from: day, to: day, bucket: z.enum(['day', 'week', 'month']).default('day'), teamId: z.string().uuid().optional() }))
    .query(async ({ ctx, input }) => {
      const v = await viewer(ctx);
      if (!v.isAdmin && !(input.teamId && v.leadTeamIds.includes(input.teamId)))
        throw new TRPCError({ code: 'FORBIDDEN', message: v.leadTeamIds.length ? 'Team leads see insights for the teams they lead' : 'Insights are for admins and team leads' });
      if (input.to < input.from) throw new TRPCError({ code: 'BAD_REQUEST', message: '"to" is before "from"' });
      const hideCost = v.settings.hideCostFromNonAdmins && !v.isAdmin;
      const team = input.teamId ? sql`AND m.user_id IN (SELECT user_id FROM team_members WHERE team_id = ${input.teamId} AND org_id = ${ctx.orgId})` : sql``;
      const where = sql`m.org_id = ${ctx.orgId} AND m.day >= ${input.from}::date AND m.day <= ${input.to}::date ${team}`;
      const bucket = sql.raw(`'${input.bucket}'`);

      return ctx.inOrg(async (tx) => {
        const rows = <T>(q: ReturnType<typeof sql>) => tx.execute(q) as unknown as Promise<T[]>;
        const [total] = await rows<KpiRow>(sql`SELECT ${KPI} FROM user_metrics_daily m WHERE ${where}`);
        const series = await rows<KpiRow & { bucket: string }>(
          sql`SELECT date_trunc(${bucket}, m.day)::date::text AS bucket, ${KPI} FROM user_metrics_daily m WHERE ${where} GROUP BY 1 ORDER BY 1`,
        );
        const byUser = await rows<KpiRow & { id: string; label: string }>(
          sql`SELECT u.id, u.github_login AS label, ${KPI} FROM user_metrics_daily m JOIN users u ON u.id = m.user_id WHERE ${where} GROUP BY u.id, u.github_login ORDER BY prs_merged DESC, cost_usd DESC`,
        );
        const byRepo = await rows<KpiRow & { id: string; label: string }>(
          sql`SELECT r.id, r.full_name AS label, ${KPI} FROM user_metrics_daily m JOIN repos r ON r.id = m.repo_id WHERE ${where} GROUP BY r.id, r.full_name ORDER BY cost_usd DESC`,
        );
        const byTeam = await rows<KpiRow & { id: string; label: string }>(
          sql`SELECT t.id, t.name AS label, ${KPI} FROM user_metrics_daily m JOIN team_members tm ON tm.user_id = m.user_id AND tm.org_id = m.org_id JOIN teams t ON t.id = tm.team_id
              WHERE ${where} ${input.teamId ? sql`AND t.id = ${input.teamId}` : sql``} GROUP BY t.id, t.name ORDER BY t.name`,
        );
        // Spend by model isn't in the rollup; it comes from metered usage directly.
        const byModel = hideCost
          ? []
          : await rows<{ model: string; cost_usd: number; tokens: number }>(sql`
              SELECT u.model, coalesce(sum(u.cost_usd), 0)::float8 AS cost_usd,
                     coalesce(sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_5m_tokens + u.cache_write_1h_tokens), 0)::float8 AS tokens
                FROM token_usage u
               WHERE u.org_id = ${ctx.orgId} AND u.created_at >= ${input.from}::date AND u.created_at < (${input.to}::date + 1)
                 ${input.teamId ? sql`AND u.user_id IN (SELECT user_id FROM team_members WHERE team_id = ${input.teamId} AND org_id = ${ctx.orgId})` : sql``}
               GROUP BY u.model ORDER BY cost_usd DESC`);
        const labelled = (list: (KpiRow & { id: string; label: string })[]) => list.map((r) => ({ id: r.id, label: r.label, ...kpis(r, hideCost) }));
        return {
          range: { from: input.from, to: input.to, bucket: input.bucket },
          dataThrough: v.settings.insightsComputedAt,
          costHidden: hideCost,
          totals: kpis(total!, hideCost),
          series: series.map((r) => ({ bucket: r.bucket, ...kpis(r, hideCost) })),
          byUser: labelled(byUser),
          byTeam: labelled(byTeam),
          byRepo: labelled(byRepo),
          byModel: byModel.map((r) => ({ model: r.model, costUsd: Number(r.cost_usd), tokens: Number(r.tokens) })),
        };
      });
    }),

  /** One board. Impact ranks as computed nightly; the Tokens tab re-sorts by tokens. */
  leaderboard: orgProcedure
    .input(
      z.object({
        period: z.enum(LEADERBOARD_PERIODS).default('month'),
        offset: z.number().int().min(0).max(24).default(0),
        scope: z.enum(['org', 'team', 'repo']).default('org'),
        scopeId: z.string().uuid().optional(),
        tab: z.enum(['impact', 'tokens']).default('impact'),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (input.scope !== 'org' && !input.scopeId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose a team or repository' });
      const v = await viewer(ctx);
      if (!canSeeBoard(v, input.scope, input.scopeId))
        throw new TRPCError({
          code: 'FORBIDDEN',
          message:
            v.settings.leaderboardVisibility === 'team_leads'
              ? 'The leaderboard is open to admins, and to team leads for their own teams'
              : 'Only admins can see the leaderboard in this organization',
        });
      const hideCost = v.settings.hideCostFromNonAdmins && !v.isAdmin;
      const range = periodRange(input.period, input.offset);

      return ctx.inOrg(async (tx) => {
        const rows = await tx
          .select({
            userId: leaderboardSnapshots.userId,
            login: users.githubLogin,
            name: users.name,
            avatarUrl: users.avatarUrl,
            rank: leaderboardSnapshots.rank,
            impactScore: leaderboardSnapshots.impactScore,
            prsMerged: leaderboardSnapshots.prsMerged,
            approvalRate: leaderboardSnapshots.approvalRate,
            costUsd: leaderboardSnapshots.costUsd,
            costPerPrUsd: leaderboardSnapshots.costPerPrUsd,
            tokens: leaderboardSnapshots.tokens,
            badges: leaderboardSnapshots.badges,
            computedAt: leaderboardSnapshots.computedAt,
          })
          .from(leaderboardSnapshots)
          .innerJoin(users, eq(users.id, leaderboardSnapshots.userId))
          .where(
            and(
              eq(leaderboardSnapshots.orgId, ctx.orgId),
              eq(leaderboardSnapshots.period, input.period),
              eq(leaderboardSnapshots.periodStart, range.start),
              eq(leaderboardSnapshots.scope, input.scope),
              input.scopeId ? eq(leaderboardSnapshots.scopeId, input.scopeId) : sql`${leaderboardSnapshots.scopeId} IS NULL`,
            ),
          )
          .orderBy(asc(leaderboardSnapshots.rank));
        const ordered = input.tab === 'tokens' ? [...rows].sort((a, b) => b.tokens - a.tokens || a.rank - b.rank) : rows;

        // Scope pickers: everything for those who may see every board, otherwise only the teams they lead.
        const everything = v.isAdmin || v.settings.leaderboardVisibility === 'all';
        const teamOptions = await tx.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.orgId, ctx.orgId)).orderBy(asc(teams.name));
        const repoOptions = everything ? await tx.select({ id: repos.id, name: repos.fullName }).from(repos).where(eq(repos.orgId, ctx.orgId)).orderBy(asc(repos.fullName)) : [];

        return {
          period: input.period,
          range,
          tab: input.tab,
          costHidden: hideCost,
          badgesEnabled: v.settings.badgesEnabled,
          computedAt: rows[0]?.computedAt ?? null,
          scopes: {
            org: everything,
            teams: everything ? teamOptions : teamOptions.filter((t) => v.leadTeamIds.includes(t.id)),
            repos: repoOptions,
          },
          rows: ordered.map((r, i) => ({
            userId: r.userId,
            login: r.login,
            name: r.name,
            avatarUrl: r.avatarUrl,
            rank: input.tab === 'tokens' ? i + 1 : r.rank,
            impactScore: Number(r.impactScore),
            prsMerged: r.prsMerged,
            approvalRate: num(r.approvalRate),
            costUsd: hideCost ? null : Number(r.costUsd),
            costPerPrUsd: hideCost ? null : num(r.costPerPrUsd),
            tokens: r.tokens,
            badges: v.settings.badgesEnabled ? r.badges : [],
            isYou: r.userId === ctx.userId,
          })),
        };
      });
    }),
});
