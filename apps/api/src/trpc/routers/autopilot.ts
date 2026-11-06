import { currentWindow, nextLocalTime, nextWindowStart, stopAutopilot, validTimezone } from '@autodev/autopilot';
import { and, desc, eq, inArray, isNotNull, isNull, schema, sql } from '@autodev/db';
import { isDemoOrg } from '@autodev/demo';
import { closePr, markPrReady, userOctokit } from '@autodev/github';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, orgProcedure, roleAtLeast, router } from '../trpc';
import type { Ctx } from './tasks';
import { transition } from '../../services/tasks';

/** The org context plus the audit helper every org procedure has. */
type OrgCtx = Ctx & { audit: (tx: Parameters<Parameters<Ctx['inOrg']>[0]>[0], e: { action: string; targetType?: string; targetId?: string; metadata?: Record<string, unknown> }) => Promise<void> };

const { autopilotRuns, autopilotSettings, orgs, pullRequests, repos, taskQuestions, tasks, tokenUsage } = schema;

const DEFAULTS = { enabled: false, timezone: 'UTC', startMinute: 19 * 60, endMinute: 7 * 60, days: [1, 2, 3, 4, 5], nightlyBudgetUsd: '20.00', maxTasks: 5, runUntil: null as Date | null };

async function settingsFor(ctx: OrgCtx) {
  const [s] = await ctx.deps.sys.select().from(autopilotSettings).where(and(eq(autopilotSettings.orgId, ctx.orgId), eq(autopilotSettings.userId, ctx.userId)));
  return s ?? { ...DEFAULTS, orgId: ctx.orgId, userId: ctx.userId };
}

async function orgAllows(ctx: OrgCtx) {
  const [o] = await ctx.deps.sys.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, ctx.orgId));
  return (o?.settings as { autopilot?: { allowed?: boolean } } | undefined)?.autopilot?.allowed !== false;
}

/** A task the caller may act on for Autopilot: their own, or any as an admin. */
async function ownTask(ctx: OrgCtx, key: string) {
  const [t] = await ctx.inOrg((tx) => tx.select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.key, key))));
  if (!t) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
  if (t.ownerId !== ctx.userId && !roleAtLeast(ctx.role, 'admin')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task owner or an admin can do this' });
  return t;
}

/** The task's open pull request, with what's needed to act on it on GitHub. */
async function openPr(ctx: OrgCtx, taskId: string) {
  const [pr] = await ctx.deps.sys
    .select({ id: pullRequests.id, number: pullRequests.number, draft: pullRequests.draft, owner: repos.owner, repo: repos.name })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(eq(pullRequests.taskId, taskId), eq(pullRequests.state, 'open')))
    .orderBy(desc(pullRequests.createdAt))
    .limit(1);
  return pr ?? null;
}

const runTasks = (ctx: OrgCtx, runIds: string[]) =>
  runIds.length
    ? ctx.deps.sys
        .select({
          runId: tasks.autopilotRunId,
          key: tasks.key,
          title: tasks.title,
          status: tasks.status,
          repo: repos.fullName,
          prNumber: pullRequests.number,
          prUrl: pullRequests.url,
          prDraft: pullRequests.draft,
          prState: pullRequests.state,
          decisions: sql<number>`(select count(*)::int from ${taskQuestions} q where q.task_id = ${tasks.id} and q.answered_by is null and q.answered_at is not null)`,
          costUsd: sql<string>`(select coalesce(sum(u.cost_usd), 0) from ${tokenUsage} u where u.task_id = ${tasks.id})`,
        })
        .from(tasks)
        .innerJoin(repos, eq(repos.id, tasks.repoId))
        .leftJoin(pullRequests, eq(pullRequests.taskId, tasks.id))
        .where(and(eq(tasks.orgId, ctx.orgId), inArray(tasks.autopilotRunId, runIds)))
    : Promise.resolve([]);

/**
 * Autopilot: queue tasks, and the agent works through them in your window (overnight by default),
 * approving its own plans, assuming instead of asking, and opening draft PRs. In the morning you
 * mark each ready, send it back with notes, or discard it.
 */
export const autopilotRouter = router({
  get: orgProcedure.query(async ({ ctx }) => {
    const s = await settingsFor(ctx);
    const now = new Date();
    const win = { timezone: s.timezone, startMinute: s.startMinute, endMinute: s.endMinute, days: s.days };
    const queue = await ctx.inOrg((tx) =>
      tx
        .select({ key: tasks.key, title: tasks.title, priority: tasks.priority, mode: tasks.mode, repo: repos.fullName, queuedAt: tasks.autopilotQueuedAt })
        .from(tasks)
        .innerJoin(repos, eq(repos.id, tasks.repoId))
        .where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.ownerId, ctx.userId), eq(tasks.autopilot, true), eq(tasks.status, 'draft')))
        .orderBy(sql`case ${tasks.priority} when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`, tasks.autopilotQueuedAt),
    );
    const runs = await ctx.deps.sys
      .select()
      .from(autopilotRuns)
      .where(and(eq(autopilotRuns.orgId, ctx.orgId), eq(autopilotRuns.userId, ctx.userId)))
      .orderBy(desc(autopilotRuns.startedAt))
      .limit(5);
    const ran = await runTasks(ctx, runs.map((r) => r.id));
    return {
      settings: { enabled: s.enabled, timezone: s.timezone, startMinute: s.startMinute, endMinute: s.endMinute, days: s.days, nightlyBudgetUsd: Number(s.nightlyBudgetUsd), maxTasks: s.maxTasks, runUntil: s.runUntil },
      allowed: await orgAllows(ctx),
      isAdmin: roleAtLeast(ctx.role, 'admin'),
      demo: await isDemoOrg(ctx.deps.sys, ctx.orgId),
      inWindow: !!(s.runUntil && s.runUntil > now) || (s.enabled && !!currentWindow(win, now)),
      nextStart: s.enabled ? nextWindowStart(win, now) : null,
      queue,
      runs: runs.map((r) => ({ ...r, tasks: ran.filter((t) => t.runId === r.id).map((t) => ({ ...t, costUsd: Number(t.costUsd) })) })),
    };
  }),

  save: orgProcedure
    .input(
      z.object({
        enabled: z.boolean(),
        timezone: z.string().max(64).refine(validTimezone, 'Not a time zone'),
        startMinute: z.number().int().min(0).max(1439),
        endMinute: z.number().int().min(0).max(1439),
        days: z.array(z.number().int().min(1).max(7)).max(7),
        nightlyBudgetUsd: z.number().min(1).max(10_000),
        maxTasks: z.number().int().min(1).max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.enabled && !(await orgAllows(ctx))) throw new TRPCError({ code: 'FORBIDDEN', message: 'An admin has turned Autopilot off for this organization' });
      if (input.startMinute === input.endMinute) throw new TRPCError({ code: 'BAD_REQUEST', message: 'The window must start and end at different times' });
      const values = { ...input, days: [...new Set(input.days)].sort(), nightlyBudgetUsd: input.nightlyBudgetUsd.toFixed(2), orgId: ctx.orgId, userId: ctx.userId, updatedAt: new Date() };
      await ctx.inOrg(async (tx) => {
        await tx.insert(autopilotSettings).values(values).onConflictDoUpdate({ target: [autopilotSettings.orgId, autopilotSettings.userId], set: values });
        await ctx.audit(tx, { action: 'autopilot.settings_updated', targetType: 'user', targetId: ctx.userId, metadata: { ...input } });
      });
      return { ok: true };
    }),

  /** A one-off run from now until the window's end time (tomorrow morning), whatever the schedule. */
  runUntilMorning: orgProcedure.mutation(async ({ ctx }) => {
    if (!(await orgAllows(ctx))) throw new TRPCError({ code: 'FORBIDDEN', message: 'An admin has turned Autopilot off for this organization' });
    const s = await settingsFor(ctx);
    const until = nextLocalTime(s.timezone, s.endMinute, new Date());
    const { orgId: _o, userId: _u, ...rest } = s as typeof s & { updatedAt?: Date };
    const values = { ...DEFAULTS, ...rest, orgId: ctx.orgId, userId: ctx.userId, runUntil: until, updatedAt: new Date() };
    await ctx.inOrg(async (tx) => {
      await tx.insert(autopilotSettings).values(values).onConflictDoUpdate({ target: [autopilotSettings.orgId, autopilotSettings.userId], set: { runUntil: until, updatedAt: new Date() } });
      await ctx.audit(tx, { action: 'autopilot.run_until', targetType: 'user', targetId: ctx.userId, metadata: { until: until.toISOString() } });
    });
    return { until };
  }),

  /** No more tasks this session; one already running finishes. */
  stop: orgProcedure.mutation(async ({ ctx }) => {
    await stopAutopilot(ctx.deps.sys, ctx.orgId, ctx.userId);
    await ctx.inOrg((tx) => ctx.audit(tx, { action: 'autopilot.stopped', targetType: 'user', targetId: ctx.userId }));
    return { ok: true };
  }),

  /** Put a draft task in (or take it out of) your Autopilot queue. */
  queue: orgProcedure.input(z.object({ key: z.string(), on: z.boolean() })).mutation(async ({ ctx, input }) => {
    const t = await ownTask(ctx, input.key);
    if (input.on && t.status !== 'draft') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only draft tasks can be queued for Autopilot' });
    if (input.on && t.ownerId !== ctx.userId) throw new TRPCError({ code: 'FORBIDDEN', message: 'Autopilot runs your own tasks; ask the owner to queue it' });
    await ctx.inOrg(async (tx) => {
      await tx.update(tasks).set({ autopilot: input.on, autopilotQueuedAt: input.on ? new Date() : null }).where(eq(tasks.id, t.id));
      await ctx.audit(tx, { action: input.on ? 'autopilot.queued' : 'autopilot.unqueued', targetType: 'task', targetId: t.id, metadata: { task: t.key } });
    });
    return { ok: true };
  }),

  /** Morning review: the draft PR becomes ready for review (on GitHub, as you). */
  markReady: orgProcedure.input(z.object({ key: z.string() })).mutation(async ({ ctx, input }) => {
    const t = await ownTask(ctx, input.key);
    const pr = await openPr(ctx, t.id);
    if (!pr) throw new TRPCError({ code: 'BAD_REQUEST', message: 'This task has no open pull request' });
    if (pr.draft && !(await isDemoOrg(ctx.deps.sys, ctx.orgId))) await ctx.deps.vault.withToken(ctx.userId, (token) => markPrReady(userOctokit(ctx.deps.cfg, token), pr.owner, pr.repo, pr.number));
    await ctx.deps.sys.update(pullRequests).set({ draft: false }).where(eq(pullRequests.id, pr.id));
    await ctx.inOrg((tx) => ctx.audit(tx, { action: 'autopilot.pr_ready', targetType: 'task', targetId: t.id, metadata: { task: t.key, pr: pr.number } }));
    return { ok: true };
  }),

  /** Morning review: not quite right. A follow-up task with your notes goes into tonight's queue. */
  sendBack: orgProcedure.input(z.object({ key: z.string(), notes: z.string().trim().min(3).max(10_000) })).mutation(async ({ ctx, input }) => {
    const t = await ownTask(ctx, input.key);
    const key = await ctx.inOrg(async (tx) => {
      const [seq] = await tx.update(orgs).set({ taskSeq: sql`${orgs.taskSeq} + 1` }).where(eq(orgs.id, ctx.orgId)).returning({ n: orgs.taskSeq, prefix: orgs.taskKeyPrefix });
      const k = `${seq!.prefix}-${seq!.n}`;
      const [follow] = await tx
        .insert(tasks)
        .values({
          orgId: ctx.orgId,
          repoId: t.repoId,
          number: seq!.n,
          key: k,
          title: `Follow-up: ${t.title}`.slice(0, 200),
          descriptionMd: `Changes requested on ${t.key} (its pull request is on branch \`${t.workBranch}\`):\n\n${input.notes}`,
          acceptanceCriteriaMd: t.acceptanceCriteriaMd,
          priority: t.priority,
          mode: t.mode,
          branchMode: 'existing',
          targetBranch: t.workBranch,
          workBranch: t.workBranch,
          relatedTaskId: t.id,
          createPrOnCompletion: true,
          ownerId: t.ownerId,
          createdBy: ctx.userId,
          autopilot: true,
          autopilotQueuedAt: new Date(),
        })
        .returning();
      await tx.insert(schema.taskEvents).values({ orgId: ctx.orgId, taskId: follow!.id, actorType: 'user', actorUserId: ctx.userId, type: 'created' });
      await ctx.audit(tx, { action: 'autopilot.sent_back', targetType: 'task', targetId: t.id, metadata: { task: t.key, followUp: k } });
      return k;
    });
    return { key };
  }),

  /** Morning review: not wanted. The PR is closed and the task cancelled. */
  discard: orgProcedure.input(z.object({ key: z.string() })).mutation(async ({ ctx, input }) => {
    const t = await ownTask(ctx, input.key);
    const pr = await openPr(ctx, t.id);
    if (pr && !(await isDemoOrg(ctx.deps.sys, ctx.orgId))) await ctx.deps.vault.withToken(ctx.userId, (token) => closePr(userOctokit(ctx.deps.cfg, token), pr.owner, pr.repo, pr.number));
    if (pr) await ctx.deps.sys.update(pullRequests).set({ state: 'closed' }).where(eq(pullRequests.id, pr.id));
    if (t.status === 'pr_open' || t.status === 'pushed' || t.status === 'failed' || t.status === 'draft') {
      await ctx.inOrg((tx) => transition(tx, t, t.status === 'pushed' ? 'failed' : 'cancelled', { type: 'user', userId: ctx.userId }, { reason: 'autopilot_discarded' }).catch(() => null));
    }
    await ctx.inOrg((tx) => ctx.audit(tx, { action: 'autopilot.discarded', targetType: 'task', targetId: t.id, metadata: { task: t.key } }));
    return { ok: true };
  }),

  reviewed: orgProcedure.input(z.object({ runId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    await ctx.deps.sys
      .update(autopilotRuns)
      .set({ reviewedAt: new Date() })
      .where(and(eq(autopilotRuns.id, input.runId), eq(autopilotRuns.orgId, ctx.orgId), eq(autopilotRuns.userId, ctx.userId), isNull(autopilotRuns.reviewedAt), isNotNull(autopilotRuns.endedAt)));
    return { ok: true };
  }),

  /** Admins: allow or forbid Autopilot in the organization. */
  setAllowed: adminProcedure.input(z.object({ allowed: z.boolean() })).mutation(async ({ ctx, input }) => {
    await ctx.inOrg(async (tx) => {
      await tx
        .update(orgs)
        .set({ settings: sql`jsonb_set(${orgs.settings}, '{autopilot}', coalesce(${orgs.settings} -> 'autopilot', '{}'::jsonb) || ${JSON.stringify({ allowed: input.allowed })}::jsonb)` })
        .where(eq(orgs.id, ctx.orgId));
      await ctx.audit(tx, { action: input.allowed ? 'autopilot.allowed' : 'autopilot.forbidden', targetType: 'org', targetId: ctx.orgId });
    });
    return { ok: true };
  }),
});
