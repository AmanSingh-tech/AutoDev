import { randomUUID } from 'node:crypto';
import { createSystemDb, eq, schema } from '@autodev/db';
import { makeOrg, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { advanceAutopilotTask, ASSUME_ANSWER, autopilotTick, currentWindow, nextLocalTime, nextWindowStart, stopAutopilot } from './index';

describe('windows', () => {
  const night = { timezone: 'Asia/Kolkata', startMinute: 19 * 60, endMinute: 7 * 60, days: [1, 2, 3, 4, 5] };
  // 2026-11-06 is a Friday. IST = UTC+5:30.
  const ist = (iso: string) => new Date(`${iso}+05:30`);

  it('runs weekday nights into the next morning, in the person’s time zone', () => {
    expect(currentWindow(night, ist('2026-11-06T18:59:00'))).toBeNull();
    const fri = currentWindow(night, ist('2026-11-06T21:00:00'))!;
    expect(fri.start.toISOString()).toBe(ist('2026-11-06T19:00:00').toISOString());
    expect(fri.end.toISOString()).toBe(ist('2026-11-07T07:00:00').toISOString());
    // Saturday 03:00 still belongs to Friday night; Saturday night has none.
    expect(currentWindow(night, ist('2026-11-07T03:00:00'))!.start.toISOString()).toBe(fri.start.toISOString());
    expect(currentWindow(night, ist('2026-11-07T21:00:00'))).toBeNull();
    expect(currentWindow(night, ist('2026-11-08T05:00:00'))).toBeNull();
    // Sunday night isn't a weekday start, Monday night is.
    expect(nextWindowStart(night, ist('2026-11-07T10:00:00'))!.toISOString()).toBe(ist('2026-11-09T19:00:00').toISOString());
  });

  it('handles same-day windows and "until morning"', () => {
    const lunch = { timezone: 'UTC', startMinute: 12 * 60, endMinute: 13 * 60, days: [1, 2, 3, 4, 5, 6, 7] };
    expect(currentWindow(lunch, new Date('2026-11-07T12:30:00Z'))).not.toBeNull();
    expect(currentWindow(lunch, new Date('2026-11-07T13:00:00Z'))).toBeNull();
    expect(nextLocalTime('UTC', 7 * 60, new Date('2026-11-07T20:00:00Z')).toISOString()).toBe('2026-11-08T07:00:00.000Z');
  });
});

const sys = createSystemDb(TEST_SYSTEM_URL);
afterAll(() => sys.close());

let fx: Awaited<ReturnType<typeof makeOrg>>;
let jobs: string[];
const deps = (canStart: () => Promise<string | null> = async () => null) => ({ sys: sys.db, enqueue: async (_o: string, taskId: string) => void jobs.push(taskId), canStart });
beforeEach(async () => {
  await truncateAll(sys.db);
  fx = await makeOrg(sys.db, 'acme');
  jobs = [];
});

let n = 0;
async function task(o: { priority?: 'low' | 'high'; autopilot?: boolean; status?: 'draft' } = {}) {
  n++;
  const [t] = await sys.db
    .insert(schema.tasks)
    .values({ orgId: fx.org.id, repoId: fx.repo.id, number: n, key: `AD-${n}`, title: `Task ${n}`, descriptionMd: 'x', mode: 'plan_lld', branchMode: 'new', workBranch: `b-${n}`, ownerId: fx.owner.id, createdBy: fx.owner.id, priority: o.priority ?? 'medium', autopilot: o.autopilot ?? true, autopilotQueuedAt: new Date() })
    .returning();
  return t!;
}
// Always inside the window: every day, all day.
const always = { enabled: true, timezone: 'UTC', startMinute: 0, endMinute: 1439, days: [1, 2, 3, 4, 5, 6, 7] };

describe('scheduler', () => {
  it('starts the highest-priority queued task, one at a time, then the next once it is done', async () => {
    await sys.db.insert(schema.autopilotSettings).values({ orgId: fx.org.id, userId: fx.owner.id, ...always });
    const low = await task({ priority: 'low' });
    const high = await task({ priority: 'high' });
    await task({ autopilot: false });

    expect(await autopilotTick(deps())).toEqual([expect.objectContaining({ action: 'started', detail: high.key })]);
    expect(jobs).toEqual([high.id]);
    expect(await autopilotTick(deps())).toEqual([expect.objectContaining({ action: 'waiting' })]);

    await sys.db.update(schema.tasks).set({ status: 'pr_open' }).where(eq(schema.tasks.id, high.id));
    expect(await autopilotTick(deps())).toEqual([expect.objectContaining({ action: 'started', detail: low.key })]);
    await sys.db.update(schema.tasks).set({ status: 'pr_open' }).where(eq(schema.tasks.id, low.id));
    expect(await autopilotTick(deps())).toEqual([expect.objectContaining({ action: 'idle' })]);
    const [run] = await sys.db.select().from(schema.autopilotRuns);
    expect(run).toMatchObject({ status: 'running', tasksStarted: 2 });
  });

  it('stops at the nightly cap, the task limit, or a blocker, and only for that session', async () => {
    await sys.db.insert(schema.autopilotSettings).values({ orgId: fx.org.id, userId: fx.owner.id, ...always, nightlyBudgetUsd: '1.00', maxTasks: 1 });
    await task();
    await task();
    expect((await autopilotTick(deps(async () => 'No working AI key')))[0]).toMatchObject({ action: 'stopped', detail: 'No working AI key' });
    expect(jobs).toEqual([]);

    await truncateAll(sys.db);
    fx = await makeOrg(sys.db, 'acme');
    await sys.db.insert(schema.autopilotSettings).values({ orgId: fx.org.id, userId: fx.owner.id, ...always, nightlyBudgetUsd: '1.00', maxTasks: 5 });
    const t = await task();
    await autopilotTick(deps());
    await sys.db.update(schema.tasks).set({ status: 'pr_open' }).where(eq(schema.tasks.id, t.id));
    await task();
    await sys.db.insert(schema.tokenUsage).values({ id: randomUUID(), orgId: fx.org.id, userId: fx.owner.id, provider: 'anthropic', model: 'm', useCase: 'agent', costUsd: '1.20' });
    expect((await autopilotTick(deps()))[0]).toMatchObject({ action: 'stopped', detail: 'budget' });
  });

  it('closes the session outside the window with a morning summary, and respects Stop now and the org switch', async () => {
    await sys.db.insert(schema.autopilotSettings).values({ orgId: fx.org.id, userId: fx.owner.id, ...always });
    const t = await task();
    await autopilotTick(deps());
    await sys.db.insert(schema.pullRequests).values({ orgId: fx.org.id, taskId: t.id, repoId: fx.repo.id, githubPrId: 1, number: 7, url: 'u', headBranch: 'b', baseBranch: 'main', createdBy: 'agent_on_completion', draft: true });
    await sys.db.update(schema.tasks).set({ status: 'pr_open' }).where(eq(schema.tasks.id, t.id));

    await sys.db.update(schema.autopilotSettings).set({ enabled: false, runUntil: new Date(Date.now() - 1000) });
    expect((await autopilotTick(deps()))[0]).toMatchObject({ action: 'closed' });
    const [run] = await sys.db.select().from(schema.autopilotRuns);
    expect(run).toMatchObject({ status: 'done', stopReason: 'window_ended', summary: { prs: 1 } });
    const [note] = await sys.db.select().from(schema.notifications).where(eq(schema.notifications.type, 'autopilot.finished'));
    expect(note).toMatchObject({ title: 'Autopilot finished: 1 draft pull request to review', link: '/autopilot' });

    // Stop now: no more tasks this session.
    await sys.db.update(schema.autopilotSettings).set({ enabled: true, runUntil: null });
    await task();
    await stopAutopilot(sys.db, fx.org.id, fx.owner.id);
    jobs = [];
    await autopilotTick(deps());
    expect(jobs).toEqual([]);

    // An admin turned Autopilot off for the org.
    await sys.db.update(schema.orgs).set({ settings: { autopilot: { allowed: false } } }).where(eq(schema.orgs.id, fx.org.id));
    expect((await autopilotTick(deps()))[0]!.action).toMatch(/outside|closed/);
  });
});

describe('advanceAutopilotTask', () => {
  it('approves plans and designs, assumes instead of asking, and refuses deviations', async () => {
    const t = await task();
    await sys.db.update(schema.tasks).set({ status: 'awaiting_plan_approval' }).where(eq(schema.tasks.id, t.id));
    await sys.db.insert(schema.taskDocuments).values({ orgId: fx.org.id, taskId: t.id, kind: 'plan', version: 1, contentMd: 'plan', status: 'pending_review' });
    expect(await advanceAutopilotTask(deps(), t.id)).toBe('approved_plan');
    expect((await sys.db.select().from(schema.taskDocuments))[0]).toMatchObject({ status: 'approved', comment: 'Approved by Autopilot', reviewerId: null });
    expect((await sys.db.select().from(schema.tasks).where(eq(schema.tasks.id, t.id)))[0]!.status).toBe('designing');
    expect(jobs).toEqual([t.id]);

    const [run] = await sys.db.insert(schema.agentRuns).values({ orgId: fx.org.id, taskId: t.id, phase: 'code', status: 'paused', resumeStatus: 'coding' }).returning();
    await sys.db.update(schema.tasks).set({ status: 'needs_input' }).where(eq(schema.tasks.id, t.id));
    await sys.db.insert(schema.taskQuestions).values({ orgId: fx.org.id, taskId: t.id, agentRunId: run!.id, kind: 'question', questionMd: 'Which one?' });
    expect(await advanceAutopilotTask(deps(), t.id)).toBe('assumed');
    expect((await sys.db.select().from(schema.taskQuestions))[0]).toMatchObject({ answerMd: ASSUME_ANSWER, answeredBy: null });
    expect((await sys.db.select().from(schema.tasks).where(eq(schema.tasks.id, t.id)))[0]!.status).toBe('coding');

    await sys.db.update(schema.tasks).set({ status: 'needs_input' }).where(eq(schema.tasks.id, t.id));
    await sys.db.insert(schema.taskQuestions).values({ orgId: fx.org.id, taskId: t.id, agentRunId: run!.id, kind: 'deviation', questionMd: 'May I edit x?', paths: ['x'] });
    expect(await advanceAutopilotTask(deps(), t.id)).toBe('denied_deviation');

    // Tasks not on Autopilot are left for their owner.
    const manual = await task({ autopilot: false });
    await sys.db.update(schema.tasks).set({ status: 'awaiting_plan_approval' }).where(eq(schema.tasks.id, manual.id));
    expect(await advanceAutopilotTask(deps(), manual.id)).toBeNull();
  });
});
