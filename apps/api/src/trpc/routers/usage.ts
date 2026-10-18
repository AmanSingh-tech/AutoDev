import { and, desc, eq, gte, lt, schema, sql } from '@autodev/db';
import { z } from 'zod';
import { orgProcedure, roleAtLeast, router } from '../trpc';

const { repos, tokenUsage, users } = schema;

const totals = {
  costUsd: sql<string>`coalesce(sum(${tokenUsage.costUsd}), 0)::text`,
  inputTokens: sql<number>`coalesce(sum(${tokenUsage.inputTokens}), 0)::bigint`,
  outputTokens: sql<number>`coalesce(sum(${tokenUsage.outputTokens}), 0)::bigint`,
  cacheWriteTokens: sql<number>`coalesce(sum(${tokenUsage.cacheWrite5mTokens} + ${tokenUsage.cacheWrite1hTokens}), 0)::bigint`,
  cacheReadTokens: sql<number>`coalesce(sum(${tokenUsage.cacheReadTokens}), 0)::bigint`,
  calls: sql<number>`count(*)::int`,
  unpricedCalls: sql<number>`count(*) filter (where not ${tokenUsage.priced})::int`,
};

export const usageRouter = router({
  /** One calendar month (UTC). Admins see the whole org; everyone else sees only their own usage. */
  summary: orgProcedure
    .input(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).optional())
    .query(({ ctx, input }) => {
      const now = new Date();
      const [y, m] = input?.month ? input.month.split('-').map(Number) : [now.getUTCFullYear(), now.getUTCMonth() + 1];
      const from = new Date(Date.UTC(y!, m! - 1, 1));
      const to = new Date(Date.UTC(y!, m!, 1));
      const isAdmin = roleAtLeast(ctx.role, 'admin');
      const where = and(
        eq(tokenUsage.orgId, ctx.orgId),
        gte(tokenUsage.createdAt, from),
        lt(tokenUsage.createdAt, to),
        isAdmin ? undefined : eq(tokenUsage.userId, ctx.userId),
      );
      const n = (v: unknown) => Number(v);
      return ctx.inOrg(async (tx) => {
        const [total] = await tx.select(totals).from(tokenUsage).where(where);
        const byUser = await tx
          .select({ userId: tokenUsage.userId, login: users.githubLogin, ...totals })
          .from(tokenUsage)
          .leftJoin(users, eq(users.id, tokenUsage.userId))
          .where(where)
          .groupBy(tokenUsage.userId, users.githubLogin)
          .orderBy(desc(sql`sum(${tokenUsage.costUsd})`));
        const byRepo = await tx
          .select({ repoId: tokenUsage.repoId, fullName: repos.fullName, ...totals })
          .from(tokenUsage)
          .leftJoin(repos, eq(repos.id, tokenUsage.repoId))
          .where(where)
          .groupBy(tokenUsage.repoId, repos.fullName)
          .orderBy(desc(sql`sum(${tokenUsage.costUsd})`));
        const byModel = await tx
          .select({ model: tokenUsage.model, ...totals })
          .from(tokenUsage)
          .where(where)
          .groupBy(tokenUsage.model)
          .orderBy(desc(sql`sum(${tokenUsage.costUsd})`));
        const daily = await tx
          .select({ day: sql<string>`to_char(date_trunc('day', ${tokenUsage.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`, costUsd: totals.costUsd })
          .from(tokenUsage)
          .where(where)
          .groupBy(sql`1`)
          .orderBy(sql`1`);
        const fix = <T extends Record<string, unknown>>(r: T) => ({
          ...r,
          inputTokens: n(r.inputTokens),
          outputTokens: n(r.outputTokens),
          cacheWriteTokens: n(r.cacheWriteTokens),
          cacheReadTokens: n(r.cacheReadTokens),
        });
        return {
          month: `${y}-${String(m).padStart(2, '0')}`,
          scope: isAdmin ? ('org' as const) : ('mine' as const),
          total: fix(total!),
          byUser: byUser.map(fix),
          byRepo: byRepo.map(fix),
          byModel: byModel.map(fix),
          daily,
        };
      });
    }),
});
