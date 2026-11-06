import { and, eq, schema } from '@autodev/db';
import { makeOrg, testKms, truncateAll } from '@autodev/db/testing';
import { createDemoOrg } from '@autodev/demo';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, callerFor, createTestDeps } from '../../test/harness';

const h = createTestDeps();
const { deps } = h;
afterAll(() => h.close());

let orgId: string;
let me: { id: string };
beforeEach(async () => {
  await truncateAll(deps.sys);
  const fx = await makeOrg(deps.sys, 'real');
  me = fx.owner;
  ({ orgId } = await createDemoOrg({ sys: deps.sys, kms: testKms, blobs: deps.blobs, webUrl: 'http://web.test' }, { id: me.id, login: 'real-owner' }));
});
const as = (u: { id: string }) => callerFor(deps, u.id, orgId);
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);
const task = async (key: string) => (await deps.sys.select().from(schema.tasks).where(and(eq(schema.tasks.orgId, orgId), eq(schema.tasks.key, key))))[0]!;

describe('Autopilot', () => {
  it('saves a schedule, queues your own drafts, and starts a run until morning', async () => {
    const a = as(me).autopilot;
    // Demo orgs start with Autopilot on (the default window), and last night's run in the history.
    expect(await a.get()).toMatchObject({ settings: { enabled: true, startMinute: 1140, endMinute: 420, days: [1, 2, 3, 4, 5] }, runs: [{ status: 'done', tasks: [{}, {}] }] });
    expect(await code(a.save({ enabled: true, timezone: 'Mars/Olympus', startMinute: 1140, endMinute: 420, days: [1], nightlyBudgetUsd: 10, maxTasks: 3 }))).toBe('BAD_REQUEST');
    await a.save({ enabled: true, timezone: 'Asia/Kolkata', startMinute: 20 * 60, endMinute: 6 * 60, days: [5, 1, 1], nightlyBudgetUsd: 12.5, maxTasks: 3 });
    const got = await a.get();
    expect(got.settings).toMatchObject({ enabled: true, timezone: 'Asia/Kolkata', days: [1, 5], nightlyBudgetUsd: 12.5 });
    expect(got.nextStart).toBeInstanceOf(Date);

    // ACME-3 is a draft owned by "you" in the demo; ACME-1 is already waiting for review.
    await a.queue({ key: 'ACME-3', on: true });
    expect(await code(a.queue({ key: 'ACME-1', on: true }))).toBe('BAD_REQUEST');
    expect((await a.get()).queue.map((t) => t.key)).toContain('ACME-3');

    const { until } = await a.runUntilMorning();
    expect(until.getTime()).toBeGreaterThan(Date.now());
    expect((await a.get()).inWindow).toBe(true);
    await a.stop();
    expect((await a.get()).settings.runUntil).toBeNull();
  });

  it('marks a draft PR ready, sends one back as a queued follow-up, and discards one', async () => {
    const a = as(me).autopilot;
    // Pretend last night ran ACME-4 (open PR, made a draft) and ACME-5.
    for (const key of ['ACME-4', 'ACME-5']) {
      const t = await task(key);
      await deps.sys.update(schema.tasks).set({ autopilot: true, ownerId: me.id }).where(eq(schema.tasks.id, t.id));
      await deps.sys.update(schema.pullRequests).set({ draft: true }).where(eq(schema.pullRequests.taskId, t.id));
    }
    await a.markReady({ key: 'ACME-4' });
    expect((await deps.sys.select().from(schema.pullRequests).where(eq(schema.pullRequests.taskId, (await task('ACME-4')).id)))[0]!.draft).toBe(false);

    const { key } = await a.sendBack({ key: 'ACME-4', notes: 'Use cursor pagination, not offsets.' });
    const follow = await task(key);
    expect(follow).toMatchObject({ status: 'draft', autopilot: true, branchMode: 'existing', relatedTaskId: (await task('ACME-4')).id });
    expect(follow.descriptionMd).toContain('Use cursor pagination');

    await a.discard({ key: 'ACME-5' });
    expect((await task('ACME-5')).status).toBe('cancelled');
    expect((await deps.sys.select().from(schema.pullRequests).where(eq(schema.pullRequests.taskId, (await task('ACME-5')).id)))[0]!.state).toBe('closed');
  });

  it('can be turned off for the whole org by an admin, and only owners act on their tasks', async () => {
    const dev = await addMember(deps, orgId, 'dev', 'developer');
    expect(await code(as(dev).autopilot.setAllowed({ allowed: false }))).toBe('FORBIDDEN');
    expect(await code(as(dev).autopilot.queue({ key: 'ACME-3', on: true }))).toBe('FORBIDDEN');
    await as(me).autopilot.setAllowed({ allowed: false });
    expect((await as(dev).autopilot.get()).allowed).toBe(false);
    expect(await code(as(me).autopilot.runUntilMorning())).toBe('FORBIDDEN');
  });

  it('a manual start takes a task out of the Autopilot queue', async () => {
    await as(me).autopilot.queue({ key: 'ACME-3', on: true });
    await as(me).tasks.start({ key: 'ACME-3' });
    expect(await task('ACME-3')).toMatchObject({ status: 'queued', autopilot: false });
  });
});
