import { and, eq, gte, schema, sql, type SystemDb } from '@autodev/db';
import { notifyAdmins } from './notify';

const { budgets, tokenUsage } = schema;

/** Budgets run on calendar months in UTC. */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
const monthKey = (d: Date) => d.toISOString().slice(0, 10);

export async function monthSpendUsd(sys: SystemDb, orgId: string, userId: string | null, now = new Date()): Promise<number> {
  const [row] = await sys
    .select({ total: sql<string>`coalesce(sum(${tokenUsage.costUsd}), 0)` })
    .from(tokenUsage)
    .where(
      and(
        eq(tokenUsage.orgId, orgId),
        gte(tokenUsage.createdAt, monthStart(now)),
        userId ? eq(tokenUsage.userId, userId) : undefined,
      ),
    );
  return Number(row?.total ?? 0);
}

export interface BudgetStatus {
  scope: 'org' | 'user';
  userId: string | null;
  limitUsd: number;
  spentUsd: number;
  softPct: number;
  hardBlock: boolean;
  overSoft: boolean;
  overHard: boolean;
}

/** The org budget and the user's own budget (if either exists) with this month's spend. */
export async function budgetStatus(sys: SystemDb, orgId: string, userId: string | null, now = new Date()): Promise<BudgetStatus[]> {
  const rows = await sys.select().from(budgets).where(eq(budgets.orgId, orgId));
  const relevant = rows.filter((b) => b.scope === 'org' || (userId && b.userId === userId));
  const out: BudgetStatus[] = [];
  for (const b of relevant) {
    const spentUsd = await monthSpendUsd(sys, orgId, b.scope === 'user' ? b.userId : null, now);
    const limitUsd = Number(b.limitUsd);
    out.push({
      scope: b.scope,
      userId: b.userId,
      limitUsd,
      spentUsd,
      softPct: b.softPct,
      hardBlock: b.hardBlock,
      overSoft: spentUsd >= (limitUsd * b.softPct) / 100,
      overHard: spentUsd >= limitUsd,
    });
  }
  return out;
}

/**
 * Sends the soft (e.g. 80%) and hard (100%) alerts at most once per budget per month.
 * A conditional UPDATE claims the alert, so concurrent workers can't double-send.
 */
export async function sendBudgetAlerts(sys: SystemDb, orgId: string, userId: string | null, now = new Date()) {
  const month = monthKey(monthStart(now));
  for (const s of await budgetStatus(sys, orgId, userId, now)) {
    const target = and(
      eq(budgets.orgId, orgId),
      eq(budgets.scope, s.scope),
      s.userId ? eq(budgets.userId, s.userId) : sql`${budgets.userId} is null`,
    );
    const who = s.scope === 'org' ? 'The organization' : 'A member';
    const extra = s.userId ? [s.userId] : [];
    if (s.overHard) {
      const claimed = await sys
        .update(budgets)
        .set({ lastHardAlertMonth: month, lastSoftAlertMonth: month })
        .where(and(target, sql`${budgets.lastHardAlertMonth} is distinct from ${month}::date`))
        .returning({ id: budgets.id });
      if (claimed.length) {
        await notifyAdmins(sys, orgId, {
          type: 'budget.hard_limit',
          title: `${who} reached its monthly AI budget ($${s.limitUsd.toFixed(2)})`,
          body: s.hardBlock ? 'New agent runs are blocked until next month or until the budget is raised.' : 'The budget is not set to block runs.',
          link: '/settings/budgets',
          payload: { scope: s.scope, userId: s.userId, spentUsd: s.spentUsd },
        }, extra);
      }
    } else if (s.overSoft) {
      const claimed = await sys
        .update(budgets)
        .set({ lastSoftAlertMonth: month })
        .where(and(target, sql`${budgets.lastSoftAlertMonth} is distinct from ${month}::date`))
        .returning({ id: budgets.id });
      if (claimed.length) {
        await notifyAdmins(sys, orgId, {
          type: 'budget.soft_limit',
          title: `${who} used ${s.softPct}% of its monthly AI budget`,
          body: `$${s.spentUsd.toFixed(2)} of $${s.limitUsd.toFixed(2)} spent this month.`,
          link: '/settings/budgets',
          payload: { scope: s.scope, userId: s.userId, spentUsd: s.spentUsd },
        }, extra);
      }
    }
  }
}
