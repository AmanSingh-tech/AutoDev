import { BuilderJobs, PgBlobStore, presenceKey } from '@autodev/agent';
import { createSystemDb, eq, schema } from '@autodev/db';
import { makeOrg, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import type { KvCache } from '@autodev/github';
import type { GatewayMessage } from '@autodev/protocol';
import { Redis } from 'ioredis';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { uuidv7 } from 'uuidv7';
import { createGateway, hashToken, redisBus } from './gateway';

const REDIS = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';
const sys = createSystemDb(TEST_SYSTEM_URL);
const redis = new Redis(REDIS, { maxRetriesPerRequest: null });
const sub = new Redis(REDIS, { maxRetriesPerRequest: null });
const cache: KvCache = {
  get: (k) => redis.get(k),
  set: async (k, v, ttl) => void (await redis.set(k, v, 'EX', ttl)),
  setIfAbsent: async (k, v, ttl) => (await redis.set(k, v, 'EX', ttl, 'NX')) === 'OK',
  del: async (k) => void (await redis.del(k)),
  incr: (k) => redis.incr(k),
};
const blobs = new PgBlobStore(sys.db);
const enqueued: string[] = [];
const jobs = new BuilderJobs({ sys: sys.db, cache, blobs, bus: redisBus(redis), enqueueAgent: async (j) => void enqueued.push(j.taskId) });
const gw = createGateway({ sys: sys.db, redis, sub, cache, blobs, jobs, log: pino({ level: 'silent' }), offerTimeoutMs: 400, offlineAfterMs: 1500 });
let url: string;

beforeAll(async () => {
  await new Promise<void>((r) => gw.server.listen(0, r));
  url = `ws://127.0.0.1:${(gw.server.address() as AddressInfo).port}/builder`;
});
afterAll(async () => {
  await gw.close();
  await sys.close();
  redis.disconnect();
  sub.disconnect();
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
let builderId: string;
const TOKEN = 'adb_' + 'x'.repeat(40);
const open: WebSocket[] = [];
afterEach(() => {
  for (const ws of open.splice(0)) ws.terminate();
});
beforeEach(async () => {
  await truncateAll(sys.db);
  await redis.flushdb();
  enqueued.length = 0;
  fx = await makeOrg(sys.db, 'acme');
  const [b] = await sys.db.insert(schema.builders).values({ orgId: fx.org.id, ownerUserId: fx.owner.id, name: 'laptop', tokenHash: hashToken(TOKEN), dockerAvailable: true }).returning();
  builderId = b!.id;
  await sys.db.insert(schema.builderRepoBindings).values({ builderId, repoId: fx.repo.id, orgId: fx.org.id, firstRunConfirmedAt: new Date() });
});

/** A fake builder: collects messages and lets the test wait for a type. */
function connect(token = TOKEN) {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  // Rejected handshakes and terminated sockets emit 'error'; the tests assert on status codes instead.
  ws.on('error', () => {});
  open.push(ws);
  const inbox: GatewayMessage[] = [];
  const waiters: { type: string; resolve: (m: GatewayMessage) => void }[] = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString()) as GatewayMessage;
    const w = waiters.findIndex((x) => x.type === m.type);
    if (w >= 0) waiters.splice(w, 1)[0]!.resolve(m);
    else inbox.push(m);
  });
  return {
    ws,
    send: (m: object) => ws.send(JSON.stringify(m)),
    next: <T extends GatewayMessage['type']>(type: T) =>
      new Promise<Extract<GatewayMessage, { type: T }>>((resolve, reject) => {
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) return resolve(inbox.splice(i, 1)[0] as never);
        waiters.push({ type, resolve: resolve as never });
        setTimeout(() => reject(new Error(`no ${type} message`)), 10_000);
      }),
    opened: () => new Promise<void>((r, j) => (ws.once('open', () => r()), ws.once('unexpected-response', (_q, res) => j(new Error(String(res.statusCode)))))),
    closed: () => new Promise<number>((r) => ws.once('close', (code) => r(code))),
  };
}
const hello = { type: 'hello', protocol: 1, cliVersion: '0.1.0', os: 'linux', arch: 'x64', dockerAvailable: true, runningJobId: null };

async function queuedJob() {
  const [t] = await sys.db
    .insert(schema.tasks)
    .values({ orgId: fx.org.id, repoId: fx.repo.id, number: 1, key: 'AD-1', title: 'x', mode: 'direct', branchMode: 'new', workBranch: 'autodev/AD-1', ownerId: fx.owner.id, status: 'waiting_for_builder' })
    .returning();
  const id = uuidv7();
  await blobs.put(fx.org.id, `jobs/${id}/patch.diff`, 'diff --git a/x b/x\n');
  await sys.db.insert(schema.builderJobs).values({ id, orgId: fx.org.id, taskId: t!.id, repoId: fx.repo.id, requestedBy: fx.owner.id, baseSha: 'b'.repeat(40), workspaceRevision: 1, patchKey: `jobs/${id}/patch.diff`, patchSha256: 'c'.repeat(64), configSnapshot: { test: ['pnpm test'], timeout_min: 15 } });
  return { taskId: t!.id, jobId: id };
}
const until = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 50; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met');
};

describe('builder gateway', () => {
  it('rejects unknown and revoked tokens', async () => {
    await expect(connect('adb_' + 'n'.repeat(40)).opened()).rejects.toThrow('401');
    await sys.db.update(schema.builders).set({ revokedAt: new Date() });
    await expect(connect().opened()).rejects.toThrow('401');
  });

  it('greets, records the machine, marks it online, and offers queued work on connect', async () => {
    const { jobId } = await queuedJob();
    const b = connect();
    await b.opened();
    b.send(hello);
    expect(await b.next('hello')).toMatchObject({ builderId, heartbeatIntervalMs: 20_000 });
    const offer = await b.next('job.offer');
    expect(offer).toMatchObject({ jobId, patch: 'diff --git a/x b/x\n', config: { test: ['pnpm test'] } });
    expect(await redis.get(presenceKey(builderId))).not.toBeNull();
    const [row] = await sys.db.select().from(schema.builders);
    expect(row).toMatchObject({ os: 'linux', cliVersion: '0.1.0' });
  });

  it('accepts, stores streamed logs, records the result and wakes the agent', async () => {
    const { taskId, jobId } = await queuedJob();
    const b = connect();
    await b.opened();
    b.send(hello);
    await b.next('job.offer');
    b.send({ type: 'job.accept', jobId });
    await until(async () => (await sys.db.select().from(schema.tasks))[0]!.status === 'testing');
    b.send({ type: 'log.chunk', jobId, seq: 0, step: 'test', stream: 'stdout', data: 'running tests\n' });
    b.send({ type: 'log.chunk', jobId, seq: 1, step: 'test', stream: 'stdout', data: '1 passed\n' });
    b.send({ type: 'job.result', jobId, status: 'passed', step: 'test', exitCode: 0, failedTests: [], durationMs: 900, logTail: '1 passed' });
    await until(async () => enqueued.length === 1);
    const [job] = await sys.db.select().from(schema.builderJobs).where(eq(schema.builderJobs.id, jobId));
    expect(job).toMatchObject({ status: 'passed', exitCode: 0, logKey: `jobs/${jobId}/log.txt` });
    expect((await blobs.get(job!.logKey!))!.toString()).toBe('running tests\n1 passed\n');
    expect(enqueued).toEqual([taskId]);
  });

  it('re-offers a job the builder did not accept in time', async () => {
    const { jobId } = await queuedJob();
    const b = connect();
    await b.opened();
    b.send(hello);
    await b.next('job.offer');
    // Ignore it: after the timeout it's released and (the builder being free again) offered once more.
    expect((await b.next('job.offer')).jobId).toBe(jobId);
  });

  it('re-queues the running job and goes offline when the builder disconnects', async () => {
    const { jobId } = await queuedJob();
    const b = connect();
    await b.opened();
    b.send(hello);
    await b.next('job.offer');
    b.send({ type: 'job.accept', jobId });
    await until(async () => (await sys.db.select().from(schema.builderJobs))[0]!.status === 'running');
    b.ws.close();
    await until(async () => (await sys.db.select().from(schema.builderJobs))[0]!.status === 'queued');
    expect(await redis.get(presenceKey(builderId))).toBeNull();
    expect((await sys.db.select().from(schema.tasks))[0]!.status).toBe('waiting_for_builder');
  });

  it('closes the connection on an invalid message, and drops builders that go silent', async () => {
    const bad = connect();
    await bad.opened();
    bad.send({ type: 'exec', cmd: 'rm -rf /' });
    expect(await bad.closed()).toBe(4002);

    const quiet = connect();
    await quiet.opened();
    quiet.send(hello);
    await quiet.next('hello');
    expect(await quiet.closed()).toBe(1006); // terminated after the offline window
  });

  it('disconnects a revoked builder on its next heartbeat', async () => {
    const b = connect();
    await b.opened();
    b.send(hello);
    await b.next('hello');
    await sys.db.update(schema.builders).set({ revokedAt: new Date() });
    b.send({ type: 'heartbeat', ts: Date.now() });
    expect(await b.closed()).toBe(4001);
  });

  it("ignores logs and results for a job that isn't this builder's", async () => {
    await queuedJob();
    const b = connect();
    await b.opened();
    b.send(hello);
    await b.next('hello');
    const other = uuidv7();
    b.send({ type: 'job.result', jobId: other, status: 'passed', step: 'test', exitCode: 0, failedTests: [], durationMs: 1, logTail: '' });
    await new Promise((r) => setTimeout(r, 200));
    expect(enqueued).toEqual([]);
  });
});
