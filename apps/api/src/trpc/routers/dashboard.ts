import { and, count, desc, eq, gte, inArray, isNull, schema, sql } from '@autodev/db';
import { orgProcedure, roleAtLeast, router } from '../trpc';

const { builders, pullRequests, repos, tasks, tokenUsage } = schema;

/** Waiting on a person: approve a plan or design, answer a question, fix a key. */
export const ATTENTION = ['awaiting_plan_approval', 'awaiting_lld_approval', 'needs_input', 'blocked_on_key'] as const;
/** The agent or a builder is working on it. */
export const RUNNING = ['queued', 'planning', 'designing', 'coding', 'waiting_for_builder', 'testing', 'fixing'] as const;

/**
 * The org home page in one call: what needs you, what's running, recent pull requests, this
 * month's spend and the builders. Admins see the whole org; everyone else sees their own tasks
 * and spend. Everything runs inside the org's row-level security.
 */
export const dashboardRouter = router({
  get: orgProcedure.query(({ ctx }) => {
    const isAdmin = roleAtLeast(ctx.role, 'admin');
    const mine = isAdmin ? undefined : eq(tasks.ownerId, ctx.userId);
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const taskCols = { key: tasks.key, title: tasks.title, status: tasks.status, updatedAt: tasks.updatedAt, repo: repos.name, repoFullName: repos.fullName };

    return ctx.inOrg(async (tx) => {
      const [attention, running, prs, [spend], [merged], [opened], [repoCount], fleet] = await Promise.all([
        tx
          .select(taskCols)
          .from(tasks)
          .innerJoin(repos, eq(repos.id, tasks.repoId))
          .where(and(eq(tasks.orgId, ctx.orgId), inArray(tasks.status, [...ATTENTION]), mine))
          .orderBy(desc(tasks.updatedAt))
          .limit(8),
        tx
          .select(taskCols)
          .from(tasks)
          .innerJoin(repos, eq(repos.id, tasks.repoId))
          .where(and(eq(tasks.orgId, ctx.orgId), inArray(tasks.status, [...RUNNING]), mine))
          .orderBy(desc(tasks.updatedAt))
          .limit(8),
        tx
          .select({ number: pullRequests.number, url: pullRequests.url, state: pullRequests.state, createdAt: pullRequests.createdAt, mergedAt: pullRequests.mergedAt, taskKey: tasks.key, title: tasks.title, repoFullName: repos.fullName })
          .from(pullRequests)
          .innerJoin(tasks, eq(tasks.id, pullRequests.taskId))
          .innerJoin(repos, eq(repos.id, tasks.repoId))
          .where(and(eq(pullRequests.orgId, ctx.orgId), mine))
          .orderBy(desc(pullRequests.createdAt))
          .limit(6),
        tx
          .select({ costUsd: sql<string>`coalesce(sum(${tokenUsage.costUsd}), 0)` })
          .from(tokenUsage)
          .where(and(eq(tokenUsage.orgId, ctx.orgId), gte(tokenUsage.createdAt, monthStart), isAdmin ? undefined : eq(tokenUsage.userId, ctx.userId))),
        tx
          .select({ n: count() })
          .from(pullRequests)
          .innerJoin(tasks, eq(tasks.id, pullRequests.taskId))
          .where(and(eq(pullRequests.orgId, ctx.orgId), gte(pullRequests.mergedAt, weekAgo), mine)),
        tx
          .select({ n: count() })
          .from(tasks)
          .where(and(eq(tasks.orgId, ctx.orgId), gte(tasks.createdAt, weekAgo), mine)),
        tx.select({ n: count() }).from(repos).where(and(eq(repos.orgId, ctx.orgId), isNull(repos.deletedAt), eq(repos.archived, false))),
        tx
          .select({ lastSeenAt: builders.lastSeenAt })
          .from(builders)
          .where(and(eq(builders.orgId, ctx.orgId), isNull(builders.revokedAt))),
      ]);
      // A builder heartbeats every ~30 s while connected.
      const online = fleet.filter((b) => b.lastSeenAt && now.getTime() - b.lastSeenAt.getTime() < 120_000).length;
      return {
        scope: isAdmin ? ('org' as const) : ('mine' as const),
        attention,
        running,
        prs,
        stats: {
          spendThisMonthUsd: Number(spend?.costUsd ?? 0),
          mergedThisWeek: Number(merged?.n ?? 0),
          tasksThisWeek: Number(opened?.n ?? 0),
          repos: Number(repoCount?.n ?? 0),
          builders: fleet.length,
          buildersOnline: online,
        },
      };
    });
  }),
});
