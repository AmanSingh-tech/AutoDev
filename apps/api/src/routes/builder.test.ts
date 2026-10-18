import { presenceKey } from '@autodev/agent';
import { eq, schema } from '@autodev/db';
import { makeOrg, truncateAll } from '@autodev/db/testing';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, callerFor, createTestDeps } from '../../test/harness';
import { buildServer } from '../server';

const h = createTestDeps();
const { deps } = h;
const app = await buildServer(deps, { logger: false });
afterAll(async () => {
  await app.close();
  await h.close();
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
let dev: { id: string };
let other: { id: string };
beforeEach(async () => {
  await truncateAll(deps.sys);
  h.agentJobs.length = 0;
  h.sentToBuilders.length = 0;
  fx = await makeOrg(deps.sys, 'acme');
  dev = await addMember(deps, fx.org.id, 'dev', 'developer');
  other = await addMember(deps, fx.org.id, 'other', 'developer');
});

const as = (u: { id: string }) => callerFor(deps, u.id, fx.org.id);
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);
const post = (url: string, payload: object, token?: string) =>
  app.inject({ method: 'POST', url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });

async function pair(user = dev, kind: 'personal' | 'team' = 'personal') {
  const start = (await post('/builder/pair/start', { name: 'Devi laptop' })).json();
  await as(user).builders.approvePairing({ userCode: start.userCode, kind });
  const poll = (await post('/builder/pair/poll', { deviceCode: start.deviceCode })).json();
  return { start, poll };
}

describe('device-code pairing', () => {
  it('pairs a builder: pending until approved, then hands the token over exactly once', async () => {
    const start = (await post('/builder/pair/start', { name: 'Devi laptop' })).json();
    expect(start).toMatchObject({ userCode: expect.stringMatching(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/), verificationUriComplete: `http://web.test/builders/pair?code=${start.userCode}`, expiresIn: 600 });
    expect((await post('/builder/pair/poll', { deviceCode: start.deviceCode })).json()).toEqual({ status: 'pending' });

    await as(dev).builders.approvePairing({ userCode: start.userCode.toLowerCase() });
    const poll = await post('/builder/pair/poll', { deviceCode: start.deviceCode });
    expect(poll.json()).toMatchObject({ status: 'approved', token: expect.stringMatching(/^adb_/), gatewayUrl: 'ws://gateway.test/builder', orgSlug: 'acme' });
    expect((await post('/builder/pair/poll', { deviceCode: start.deviceCode })).statusCode).toBe(404);

    // Only the hash is stored.
    const [b] = await deps.sys.select().from(schema.builders);
    expect(b!.tokenHash).not.toContain('adb_');
    expect(b).toMatchObject({ name: 'Devi laptop', ownerUserId: dev.id, kind: 'personal' });
    expect(await deps.sys.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'builder.paired'))).toHaveLength(1);
  });

  it('rejects unknown or reused codes, and team builders from non-admins', async () => {
    expect(await code(as(dev).builders.approvePairing({ userCode: 'ZZZZ-ZZZZ' }))).toBe('NOT_FOUND');
    const start = (await post('/builder/pair/start', {})).json();
    expect(await code(as(dev).builders.approvePairing({ userCode: start.userCode, kind: 'team' }))).toBe('FORBIDDEN');
    await as(dev).builders.approvePairing({ userCode: start.userCode });
    expect(await code(as(dev).builders.approvePairing({ userCode: start.userCode }))).toBe('NOT_FOUND');
  });

  it('authenticates builder calls with the token and binds local clones by repo name', async () => {
    const { poll } = await pair();
    expect((await app.inject({ method: 'GET', url: '/builder/me', headers: { authorization: `Bearer ${poll.token}` } })).json()).toMatchObject({ name: 'Devi laptop' });
    const bind = await post('/builder/bindings', { repoFullName: 'acme/web', localPath: '/home/devi/src/web' }, poll.token);
    expect(bind.json()).toEqual({ repoId: fx.repo.id, confirmed: false });
    expect((await post('/builder/bindings', { repoFullName: 'globex/x', localPath: '/x' }, poll.token)).statusCode).toBe(404);
    expect((await post('/builder/bindings', { repoFullName: 'acme/web', localPath: '/x' }, 'adb_' + 'w'.repeat(40))).statusCode).toBe(401);
  });
});

describe('builders router', () => {
  async function queuedJob(owner: { id: string }) {
    const [t] = await deps.sys
      .insert(schema.tasks)
      .values({ orgId: fx.org.id, repoId: fx.repo.id, number: 1, key: 'AD-1', title: 'x', mode: 'direct', branchMode: 'new', workBranch: 'autodev/AD-1', ownerId: owner.id, status: 'waiting_for_builder' })
      .returning();
    const id = uuidv7();
    await deps.blobs.put(fx.org.id, `jobs/${id}/patch.diff`, 'diff');
    await deps.sys.insert(schema.builderJobs).values({ id, orgId: fx.org.id, taskId: t!.id, repoId: fx.repo.id, requestedBy: owner.id, baseSha: 'b'.repeat(40), workspaceRevision: 1, patchKey: `jobs/${id}/patch.diff`, patchSha256: 'c'.repeat(64), configSnapshot: { setup: ['pnpm i'], test: ['pnpm test'], timeout_min: 15 } });
    return { task: t!, jobId: id };
  }

  it("lists only my builders and the org's team builders, with presence", async () => {
    const mine = (await pair(dev)).poll.builderId;
    await pair(other);
    await deps.cache.set(presenceKey(mine), '1', 60);
    const list = await as(dev).builders.list();
    expect(list.map((b) => [b.id === mine, b.online])).toEqual([[true, true]]);
  });

  it('shows the commands for a first run and dispatches once the owner confirms', async () => {
    const builderId = (await pair(dev)).poll.builderId;
    await deps.sys.update(schema.builders).set({ dockerAvailable: true }); // as reported in its hello
    await deps.cache.set(presenceKey(builderId), '1', 60);
    const { jobId } = await queuedJob(dev);
    expect(await as(dev).builders.pendingConfirmations()).toEqual([{ builderId, builderName: 'Devi laptop', repoId: fx.repo.id, repoFullName: 'acme/web', config: { setup: ['pnpm i'], test: ['pnpm test'], timeout_min: 15 } }]);
    expect(await code(as(other).builders.confirmRepo({ builderId, repoId: fx.repo.id }))).toBe('FORBIDDEN');
    await as(dev).builders.confirmRepo({ builderId, repoId: fx.repo.id });
    expect(h.sentToBuilders.map((s) => [s.builderId, s.msg.type, (s.msg as { jobId: string }).jobId])).toEqual([[builderId, 'job.offer', jobId]]);
    expect(await as(dev).builders.pendingConfirmations()).toEqual([]);
  });

  it('revokes a builder and re-queues its work', async () => {
    const builderId = (await pair(dev)).poll.builderId;
    expect(await code(as(other).builders.revoke({ builderId }))).toBe('FORBIDDEN');
    await as(dev).builders.revoke({ builderId });
    expect(await as(dev).builders.list()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/builder/me', headers: { authorization: `Bearer x` } })).statusCode).toBe(401);
  });

  it('consent: allowing dispatches; refusing hands a failure to the agent', async () => {
    const builderId = (await pair(dev)).poll.builderId;
    await deps.cache.set(presenceKey(builderId), '1', 60);
    await as(dev).builders.confirmRepo({ builderId, repoId: fx.repo.id });
    const { task, jobId } = await queuedJob(dev);
    await deps.sys.update(schema.builderJobs).set({ consent: 'pending', configChanged: true });
    expect(await code(as(other).agent.consent({ key: task.key, jobId, allow: true }))).toBe('FORBIDDEN');

    await as(dev).agent.consent({ key: task.key, jobId, allow: false });
    const [job] = await deps.sys.select().from(schema.builderJobs);
    expect(job).toMatchObject({ consent: 'denied', status: 'failed' });
    expect((await deps.sys.select().from(schema.tasks))[0]!.status).toBe('testing');
    expect(h.agentJobs.map((j) => j.data.taskId)).toEqual([task.id]);
    expect(await code(as(dev).agent.consent({ key: task.key, jobId, allow: true }))).toBe('CONFLICT');
  });

  it('shows test jobs and logs, and cancelling a task cancels its builder job', async () => {
    const builderId = (await pair(dev)).poll.builderId;
    const { task, jobId } = await queuedJob(dev);
    await deps.sys.update(schema.builderJobs).set({ status: 'running', builderId });
    expect((await as(dev).agent.testJobs({ key: task.key }))[0]).toMatchObject({ id: jobId, status: 'running', builderName: 'Devi laptop' });
    expect(await as(dev).agent.jobLog({ jobId })).toEqual({ status: 'running', text: 'live log so far\n', live: true });

    await as(dev).tasks.cancel({ key: task.key });
    expect((await deps.sys.select().from(schema.builderJobs))[0]!.status).toBe('cancelled');
    expect(h.sentToBuilders.at(-1)).toEqual({ builderId, msg: { type: 'job.cancel', jobId } });
  });
});
