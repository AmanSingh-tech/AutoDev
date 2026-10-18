import { and, eq, schema, sql } from '@autodev/db';
import { budgetStatus, monthSpendUsd } from '@autodev/llm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, orgProcedure, roleAtLeast, router } from '../trpc';

const { budgets, orgMembers, users } = schema;

export const budgetsRouter = router({
  /** Admins: every budget with this month's spend. Others: the org budget and their own. */
  list: orgProcedure.query(async ({ ctx }) => {
    const rows = await ctx.inOrg((tx) =>
      tx
        .select({ id: budgets.id, scope: budgets.scope, userId: budgets.userId, userLogin: users.githubLogin, limitUsd: budgets.limitUsd, softPct: budgets.softPct, hardBlock: budgets.hardBlock })
        .from(budgets)
        .leftJoin(users, eq(users.id, budgets.userId))
        .where(eq(budgets.orgId, ctx.orgId)),
    );
    const visible = roleAtLeast(ctx.role, 'admin') ? rows : rows.filter((b) => b.scope === 'org' || b.userId === ctx.userId);
    return Promise.all(
      visible.map(async (b) => {
        const spentUsd = await monthSpendUsd(ctx.deps.sys, ctx.orgId, b.scope === 'user' ? b.userId : null);
        const limitUsd = Number(b.limitUsd);
        return { ...b, limitUsd, spentUsd, pct: limitUsd ? Math.round((spentUsd / limitUsd) * 100) : 0 };
      }),
    );
  }),

  /** For the caller: whether a new run would be blocked, and why. */
  myStatus: orgProcedure.query(async ({ ctx }) => {
    const status = await budgetStatus(ctx.deps.sys, ctx.orgId, ctx.userId);
    return { blocked: status.some((s) => s.overHard && s.hardBlock), warnings: status.filter((s) => s.overSoft) };
  }),

  set: adminProcedure
    .input(
      z.object({
        scope: z.enum(['org', 'user']),
        userId: z.string().uuid().optional(),
        limitUsd: z.number().positive().max(10_000_000),
        softPct: z.number().int().min(1).max(100).default(80),
        hardBlock: z.boolean().default(true),
      }).refine((v) => (v.scope === 'user') === !!v.userId, 'userId is required for user budgets only'),
    )
    .mutation(({ ctx, input }) =>
      ctx.inOrg(async (tx) => {
        if (input.userId) {
          const [m] = await tx.select().from(orgMembers).where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.userId, input.userId)));
          if (!m) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not a member of this org' });
        }
        const target = and(
          eq(budgets.orgId, ctx.orgId),
          eq(budgets.scope, input.scope),
          input.userId ? eq(budgets.userId, input.userId) : sql`${budgets.userId} is null`,
        );
        const values = { limitUsd: input.limitUsd.toFixed(2), softPct: input.softPct, hardBlock: input.hardBlock, updatedBy: ctx.userId };
        const [existing] = await tx.select({ id: budgets.id }).from(budgets).where(target);
        const [row] = existing
          ? // A raised limit gets its alerts back for this month.
            await tx.update(budgets).set({ ...values, lastSoftAlertMonth: null, lastHardAlertMonth: null }).where(eq(budgets.id, existing.id)).returning()
          : await tx.insert(budgets).values({ ...values, orgId: ctx.orgId, scope: input.scope, userId: input.userId ?? null }).returning();
        await ctx.audit(tx, { action: 'budget.set', targetType: 'budget', targetId: row!.id, metadata: input });
        return row!;
      }),
    ),

  remove: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(({ ctx, input }) =>
    ctx.inOrg(async (tx) => {
      const [gone] = await tx.delete(budgets).where(and(eq(budgets.orgId, ctx.orgId), eq(budgets.id, input.id))).returning();
      if (!gone) throw new TRPCError({ code: 'NOT_FOUND' });
      await ctx.audit(tx, { action: 'budget.removed', targetType: 'budget', targetId: gone.id, metadata: { scope: gone.scope, userId: gone.userId } });
      return { ok: true };
    }),
  ),
});
