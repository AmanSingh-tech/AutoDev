import { encode } from '@auth/core/jwt';
import { eq, schema } from '@autodev/db';
import { makeOrg, truncateAll } from '@autodev/db/testing';
import { publishEvent, replayAfter } from '@autodev/events';
import { repoTopic, taskTopic, userTopic } from '@autodev/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_SECRET, addMember, createTestDeps } from '../../test/harness';
import { buildServer } from '../server';
import { HEARTBEAT_MS } from './events';

const h = createTestDeps();
const { deps } = h;
let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  app = await buildServer(deps, { logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  await deps.bridge.start();
});
afterAll(async () => {
  await app.close();
  await h.close();
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
let dev: { id: string };
let admin: { id: string };
let stranger: { id: string };
beforeEach(async () => {
  await truncateAll(deps.sys);
  await h.redis.flushdb();
  fx = await makeOrg(deps.sys, 'acme');
  dev = await addMember(deps, fx.org.id, 'dev', 'developer');
  admin = await addMember(deps, fx.org.id, 'admin', 'admin');
  const [u] = await deps.sys
    .insert(schema.users)
    .values({ githubUserId: 9_000_001, githubLogin: 'stranger' })
    .returning();
  stranger = u!;
  for (const userId of [dev.id, admin.id]) {
    await deps.sys.insert(schema.userRepoAccess).values({
      userId,
      repoId: fx.repo.id,
      orgId: fx.org.id,
      permission: 'push',
      fetchedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  }
});

async function cookieFor(userId: string) {
  const token = await encode({
    token: { uid: userId },
    secret: AUTH_SECRET,
    salt: 'authjs.session-token',
  });
  return `authjs.session-token=${token}`;
}

const url = (topics: string[], org = fx.org.id) =>
  `${base}/events?org=${org}&topics=${encodeURIComponent(topics.join(','))}`;
const open = async (
  user: { id: string } | null,
  topics: string[],
  headers: Record<string, string> = {},
) =>
  fetch(url(topics), {
    headers: { ...(user ? { cookie: await cookieFor(user.id) } : {}), ...headers },
  });

async function taskIn(orgId: string, repoId: string, ownerId: string, number: number) {
  const [t] = await deps.sys
    .insert(schema.tasks)
    .values({
      orgId,
      repoId,
      number,
      key: `AD-${number}`,
      title: 'Greet',
      mode: 'direct',
      branchMode: 'new',
      workBranch: `autodev/AD-${number}`,
      ownerId,
      status: 'queued',
      createPrOnCompletion: false,
      summaryMd: 'hi',
    })
    .returning();
  return t!;
}

/** Reads the SSE body until `done` is true for the text so far, or the timeout passes. */
async function readStream(res: Response, done: (text: string) => boolean, timeoutMs = 3000) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const timer = setTimeout(() => void reader.cancel(), timeoutMs);
  try {
    while (!done(text)) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
  return text;
}

const dataLines = (text: string) =>
  text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map(
      (l) =>
        JSON.parse(l.slice(6)) as {
          id: string;
          type: string;
          topic: string;
          payload: Record<string, unknown>;
        },
    );

describe('GET /events: who may subscribe to what', () => {
  it('needs an org and at least one valid topic', async () => {
    expect((await fetch(`${base}/events?topics=org`)).status).toBe(400);
    expect((await open(dev, ['nonsense'])).status).toBe(400);
  });

  it('needs a session', async () => {
    expect((await open(null, ['org'])).status).toBe(401);
  });

  it('refuses people outside the org', async () => {
    expect((await open(stranger, ['org'])).status).toBe(403);
  });

  it('allows a repo topic only to members who can see the repo', async () => {
    const other = await makeOrg(deps.sys, 'globex');
    expect((await open(dev, [repoTopic(other.repo.id)])).status).toBe(403);
    await deps.sys.delete(schema.userRepoAccess).where(eq(schema.userRepoAccess.userId, dev.id));
    expect((await open(dev, [repoTopic(fx.repo.id)])).status).toBe(403);
  });

  it('allows a user topic only to that user, and org:admin only to admins', async () => {
    expect((await open(dev, [userTopic(admin.id)])).status).toBe(403);
    expect((await open(dev, ['org:admin'])).status).toBe(403);
    const ok = await open(admin, ['org:admin', userTopic(admin.id)]);
    expect(ok.status).toBe(200);
    await ok.body?.cancel();
  });
});

describe('GET /events: delivery', () => {
  it('sends a status change to the task topic and moves the card on the board', async () => {
    const t = await taskIn(fx.org.id, fx.repo.id, dev.id, 1);
    const res = await open(dev, [taskTopic(t.id), repoTopic(fx.repo.id)]);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    await deps.sys
      .update(schema.tasks)
      .set({ status: 'planning' })
      .where(eq(schema.tasks.id, t.id));

    const text = await readStream(
      res,
      (s) => s.includes('task.status') && s.includes('task.moved'),
    );
    const events = dataLines(text);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'task.status',
          topic: taskTopic(t.id),
          payload: { taskId: t.id, from: 'queued', to: 'planning' },
        }),
        expect.objectContaining({
          type: 'task.moved',
          topic: repoTopic(fx.repo.id),
          payload: { taskId: t.id, from: 'queued', to: 'planning' },
        }),
      ]),
    );
    expect(text).toMatch(/^id: \d+-\d+$/m);
  });

  it('allows a task topic only to members who can see its repo', async () => {
    const t = await taskIn(fx.org.id, fx.repo.id, dev.id, 2);
    const other = await makeOrg(deps.sys, 'globex');
    const foreign = await taskIn(other.org.id, other.repo.id, other.owner.id, 1);
    expect((await open(dev, [taskTopic(foreign.id)])).status).toBe(403);
    await deps.sys.delete(schema.userRepoAccess).where(eq(schema.userRepoAccess.userId, dev.id));
    expect((await open(dev, [taskTopic(t.id)])).status).toBe(403);
  });

  it('sends a new notification to its user only', async () => {
    const res = await open(dev, [userTopic(dev.id)]);
    await deps.sys.insert(schema.notifications).values([
      { orgId: fx.org.id, userId: admin.id, type: 'key.invalid', title: 'not for dev' },
      { orgId: fx.org.id, userId: dev.id, type: 'branch.stale', title: 'for dev' },
    ]);
    const events = dataLines(await readStream(res, (s) => s.includes('for dev')));
    expect(events.map((e) => e.payload.title)).toEqual(['for dev']);
  });

  it('tells admins about a budget alert once, however many admins were notified', async () => {
    const second = await addMember(deps, fx.org.id, 'admin2', 'admin');
    const res = await open(admin, ['org:admin']);
    const alert = (userId: string) => ({
      orgId: fx.org.id,
      userId,
      type: 'budget.soft_limit',
      title: 'The organization used 80%',
      payload: { scope: 'org', userId: null, spentUsd: 80 },
    });
    await deps.sys.insert(schema.notifications).values([alert(admin.id), alert(second.id)]);
    const text = await readStream(res, (s) => s.includes('budget.warning'), 1500);
    // Give a duplicate time to arrive, if there were one.
    await new Promise((r) => setTimeout(r, 300));
    const events = dataLines(text).filter((e) => e.type === 'budget.warning');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ scope: 'org', userId: null, spentUsd: 80 });
  });

  it('tells admins when someone joins the org', async () => {
    const res = await open(admin, ['org:admin']);
    const newcomer = await addMember(deps, fx.org.id, 'newcomer', 'developer');
    const events = dataLines(await readStream(res, (s) => s.includes(newcomer.id)));
    expect(events).toEqual([
      expect.objectContaining({ type: 'member.joined', payload: { userId: newcomer.id } }),
    ]);
  });

  it('sends only the topics asked for', async () => {
    const res = await open(admin, ['org:admin']);
    await publishEvent(h.redis, {
      type: 'task.updated',
      topic: repoTopic(fx.repo.id),
      orgId: fx.org.id,
      payload: { n: 1 },
    });
    await publishEvent(h.redis, {
      type: 'credential.status',
      topic: 'org:admin',
      orgId: fx.org.id,
      payload: { n: 2 },
    });
    const events = dataLines(await readStream(res, (s) => s.includes('credential.status')));
    expect(events.map((e) => e.type)).toEqual(['credential.status']);
  });

  it('replays what was missed after Last-Event-ID, in order, then continues live', async () => {
    const topic = repoTopic(fx.repo.id);
    const first = await publishEvent(h.redis, {
      type: 'task.updated',
      topic,
      orgId: fx.org.id,
      payload: { n: 1 },
    });
    await publishEvent(h.redis, {
      type: 'task.updated',
      topic,
      orgId: fx.org.id,
      payload: { n: 2 },
    });
    await publishEvent(h.redis, {
      type: 'task.updated',
      topic,
      orgId: fx.org.id,
      payload: { n: 3 },
    });

    const res = await open(dev, [topic], { 'last-event-id': first.id });
    const live = setTimeout(
      () =>
        void publishEvent(h.redis, {
          type: 'task.updated',
          topic,
          orgId: fx.org.id,
          payload: { n: 4 },
        }),
      200,
    );
    const events = dataLines(await readStream(res, (s) => s.includes('"n":4')));
    clearTimeout(live);
    expect(events.map((e) => e.payload.n)).toEqual([2, 3, 4]);
  });

  it('beats every 15 seconds so proxies keep the stream open', () => {
    expect(HEARTBEAT_MS).toBe(15_000);
  });
});

describe('ChangeBridge', () => {
  it('publishes each event of a change once, however many API processes heard it', async () => {
    const t = await taskIn(fx.org.id, fx.repo.id, dev.id, 7);
    const notice = JSON.stringify({
      t: 'tasks',
      op: 'UPDATE',
      txid: '42',
      new: {
        id: t.id,
        org_id: fx.org.id,
        repo_id: fx.repo.id,
        key: t.key,
        status: 'planning',
        last_pushed_sha: null,
        work_branch: t.workBranch,
      },
      old: {
        id: t.id,
        org_id: fx.org.id,
        repo_id: fx.repo.id,
        key: t.key,
        status: 'queued',
        last_pushed_sha: null,
        work_branch: t.workBranch,
      },
    });

    await Promise.all([
      deps.bridge.handle(notice),
      deps.bridge.handle(notice),
      deps.bridge.handle(notice),
    ]);

    // Setting up the test makes real events too; count only this change's: task.status and task.moved, once each.
    const ours = (await replayAfter(h.redis, fx.org.id, null)).filter(
      (e) => e.payload.taskId === t.id && (e.type === 'task.status' || e.type === 'task.moved'),
    );
    expect(ours.map((e) => e.type).sort()).toEqual(['task.moved', 'task.status']);
  });
});
