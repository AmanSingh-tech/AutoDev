import { and, asc, desc, eq, gte, inArray, isNotNull, or, schema, sql, transitionTask, type SystemDb, type TaskStatus } from '@autodev/db';
import { currentWindow } from './window';

const { autopilotRuns, autopilotSettings, notifications, orgs, pullRequests, tasks, tokenUsage } = schema;

/** Statuses in which an Autopilot task is still being worked on (so the next one waits). */
export const AUTOPILOT_ACTIVE: TaskStatus[] = ['queued', 'planning', 'awaiting_plan_approval', 'designing', 'awaiting_lld_approval', 'coding', 'waiting_for_builder', 'testing', 'fixing', 'needs_input'];

export interface SchedulerDeps {
  sys: SystemDb;
  enqueue: (orgId: string, taskId: string, eventId: string) => Promise<unknown>;
  /** Billing, key and budget checks a manual start would do. Returns why it can't start, or null. */
  canStart: (orgId: string, userId: string) => Promise<string | null>;
}

export interface TickResult {
  userId: string;
  orgId: string;
  action: 'started' | 'waiting' | 'idle' | 'stopped' | 'closed' | 'outside';
  detail?: string;
}

const PRIORITY = sql`case ${tasks.priority} when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`;

/**
 * One scheduler pass (the worker runs it every couple of minutes). For each person with Autopilot
 * on, or a "run until morning" going: inside the window, start their next queued task when none is
 * in progress and the nightly cap and task limit allow; outside it, close the session and leave a
 * morning summary. Tasks already running when the window ends finish; no new ones start.
 */
export async function autopilotTick(deps: SchedulerDeps, now = new Date()): Promise<TickResult[]> {
  const { sys } = deps;
  const people = await sys
    .select({ s: autopilotSettings, orgSettings: orgs.settings })
    .from(autopilotSettings)
    .innerJoin(orgs, eq(orgs.id, autopilotSettings.orgId))
    .where(or(eq(autopilotSettings.enabled, true), isNotNull(autopilotSettings.runUntil)));
  const out: TickResult[] = [];
  for (const { s, orgSettings } of people) {
    const allowed = (orgSettings as { autopilot?: { allowed?: boolean } }).autopilot?.allowed !== false;
    const oneOff = s.runUntil && s.runUntil > now ? { start: now, end: s.runUntil } : null;
    const win = allowed ? (oneOff ?? (s.enabled ? currentWindow({ timezone: s.timezone, startMinute: s.startMinute, endMinute: s.endMinute, days: s.days }, now) : null)) : null;
    const [open] = await sys
      .select()
      .from(autopilotRuns)
      .where(and(eq(autopilotRuns.orgId, s.orgId), eq(autopilotRuns.userId, s.userId), eq(autopilotRuns.status, 'running')))
      .orderBy(desc(autopilotRuns.startedAt))
      .limit(1);

    if (!win || (open && open.endsAt <= now)) {
      if (open) {
        await closeRun(sys, open, open.stopReason ?? 'window_ended', now);
        out.push({ userId: s.userId, orgId: s.orgId, action: 'closed' });
      } else out.push({ userId: s.userId, orgId: s.orgId, action: 'outside' });
      if (s.runUntil && s.runUntil <= now) await sys.update(autopilotSettings).set({ runUntil: null }).where(and(eq(autopilotSettings.orgId, s.orgId), eq(autopilotSettings.userId, s.userId)));
      continue;
    }

    // One session per window: a session stopped early (Stop now, cap reached) isn't reopened.
    let run = open;
    if (!run) {
      // (A manual "run until morning" always starts a new session.)
      const [same] = oneOff
        ? []
        : await sys
        .select()
        .from(autopilotRuns)
        .where(and(eq(autopilotRuns.orgId, s.orgId), eq(autopilotRuns.userId, s.userId), eq(autopilotRuns.endsAt, win.end)))
        .limit(1);
      if (same) {
        out.push({ userId: s.userId, orgId: s.orgId, action: 'stopped', detail: same.stopReason ?? undefined });
        continue;
      }
      [run] = await sys.insert(autopilotRuns).values({ orgId: s.orgId, userId: s.userId, endsAt: win.end, startedAt: now }).returning();
    }
    const r = run!;
    if (r.stopReason) {
      out.push({ userId: s.userId, orgId: s.orgId, action: 'stopped', detail: r.stopReason });
      continue;
    }

    // Sequential: one Autopilot task at a time per person, so a single builder is never overloaded.
    const [busy] = await sys
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.orgId, s.orgId), eq(tasks.ownerId, s.userId), eq(tasks.autopilotRunId, r.id), inArray(tasks.status, AUTOPILOT_ACTIVE)))
      .limit(1);
    if (busy) {
      out.push({ userId: s.userId, orgId: s.orgId, action: 'waiting' });
      continue;
    }

    const [spent] = await sys
      .select({ usd: sql<string>`coalesce(sum(${tokenUsage.costUsd}), 0)` })
      .from(tokenUsage)
      .where(and(eq(tokenUsage.orgId, s.orgId), eq(tokenUsage.userId, s.userId), gte(tokenUsage.createdAt, r.startedAt)));
    const stop = Number(spent?.usd ?? 0) >= Number(s.nightlyBudgetUsd) ? 'budget' : r.tasksStarted >= s.maxTasks ? 'max_tasks' : null;
    if (stop) {
      await sys.update(autopilotRuns).set({ stopReason: stop, updatedAt: now }).where(eq(autopilotRuns.id, r.id));
      out.push({ userId: s.userId, orgId: s.orgId, action: 'stopped', detail: stop });
      continue;
    }

    const [next] = await sys
      .select()
      .from(tasks)
      .where(and(eq(tasks.orgId, s.orgId), eq(tasks.ownerId, s.userId), eq(tasks.autopilot, true), eq(tasks.status, 'draft')))
      .orderBy(PRIORITY, asc(tasks.autopilotQueuedAt), asc(tasks.createdAt))
      .limit(1);
    if (!next) {
      out.push({ userId: s.userId, orgId: s.orgId, action: 'idle' });
      continue;
    }
    const blocked = await deps.canStart(s.orgId, s.userId);
    if (blocked) {
      await sys.update(autopilotRuns).set({ stopReason: blocked, updatedAt: now }).where(eq(autopilotRuns.id, r.id));
      out.push({ userId: s.userId, orgId: s.orgId, action: 'stopped', detail: blocked });
      continue;
    }
    await sys.update(tasks).set({ autopilotRunId: r.id }).where(eq(tasks.id, next.id));
    const { eventId } = await transitionTask(sys, next, 'queued', { type: 'agent', userId: null }, { autopilot: true, runId: r.id });
    await sys.update(autopilotRuns).set({ tasksStarted: sql`${autopilotRuns.tasksStarted} + 1`, updatedAt: now }).where(eq(autopilotRuns.id, r.id));
    await deps.enqueue(s.orgId, next.id, eventId);
    out.push({ userId: s.userId, orgId: s.orgId, action: 'started', detail: next.key });
  }
  return out;
}

/** Ends a session and leaves the morning summary (and a notification when anything ran). */
export async function closeRun(sys: SystemDb, run: typeof autopilotRuns.$inferSelect, reason: string, now = new Date()) {
  const ran = await sys
    .select({ key: tasks.key, title: tasks.title, status: tasks.status, pr: pullRequests.number })
    .from(tasks)
    .leftJoin(pullRequests, eq(pullRequests.taskId, tasks.id))
    .where(eq(tasks.autopilotRunId, run.id));
  const prs = ran.filter((t) => t.pr !== null).length;
  await sys
    .update(autopilotRuns)
    .set({ status: 'done', endedAt: now, stopReason: run.stopReason ?? reason, summary: { tasks: ran, prs }, updatedAt: now })
    .where(eq(autopilotRuns.id, run.id));
  if (ran.length) {
    await sys.insert(notifications).values({
      orgId: run.orgId,
      userId: run.userId,
      type: 'autopilot.finished',
      title: prs ? `Autopilot finished: ${prs} draft pull request${prs === 1 ? '' : 's'} to review` : `Autopilot finished: ${ran.length} task${ran.length === 1 ? '' : 's'} need a look`,
      body: ran.map((t) => `${t.key} ${t.title}`).join('\n').slice(0, 500),
      link: '/autopilot',
    });
  }
}

/** "Stop now": no more tasks this session; what's running finishes. */
export async function stopAutopilot(sys: SystemDb, orgId: string, userId: string, now = new Date()) {
  await sys.update(autopilotSettings).set({ runUntil: null, updatedAt: now }).where(and(eq(autopilotSettings.orgId, orgId), eq(autopilotSettings.userId, userId)));
  const [open] = await sys.select().from(autopilotRuns).where(and(eq(autopilotRuns.orgId, orgId), eq(autopilotRuns.userId, userId), eq(autopilotRuns.status, 'running')));
  if (open) return closeRun(sys, { ...open, stopReason: open.stopReason ?? 'stopped' }, 'stopped', now);
  // Nothing has started in this window yet: leave a stopped session, so the rest of it is skipped.
  const [s] = await sys.select().from(autopilotSettings).where(and(eq(autopilotSettings.orgId, orgId), eq(autopilotSettings.userId, userId)));
  const win = s && currentWindow({ timezone: s.timezone, startMinute: s.startMinute, endMinute: s.endMinute, days: s.days }, now);
  if (!win) return;
  const [same] = await sys.select({ id: autopilotRuns.id }).from(autopilotRuns).where(and(eq(autopilotRuns.orgId, orgId), eq(autopilotRuns.userId, userId), eq(autopilotRuns.endsAt, win.end)));
  if (!same) await sys.insert(autopilotRuns).values({ orgId, userId, endsAt: win.end, startedAt: now, endedAt: now, status: 'done', stopReason: 'stopped' });
}
