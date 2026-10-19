import { encode } from '@auth/core/jwt';
import { eq, schema } from '@autodev/db';
import { makeOrg, truncateAll } from '@autodev/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_SECRET, addMember, createTestDeps } from '../../test/harness';
import { buildServer } from '../server';

const h = createTestDeps();
const { deps } = h;
let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  app = await buildServer(deps, { logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(async () => {
  await app.close();
  await h.close();
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
let dev: { id: string };
let stranger: { id: string };
beforeEach(async () => {
  await truncateAll(deps.sys);
  fx = await makeOrg(deps.sys, 'acme');
  dev = await addMember(deps, fx.org.id, 'dev', 'developer');
  // A signed-in user with no membership in acme.
  const [u] = await deps.sys.insert(schema.users).values({ githubUserId: 9_000_001, githubLogin: 'stranger' }).returning();
  stranger = u!;
});

async function cookieFor(userId: string) {
  const token = await encode({ token: { uid: userId }, secret: AUTH_SECRET, salt: 'authjs.session-token' });
  return `authjs.session-token=${token}`;
}

async function taskIn(orgId: string, repoId: string, ownerId: string, number: number) {
  const [t] = await deps.sys
    .insert(schema.tasks)
    .values({ orgId, repoId, number, key: `AD-${number}`, title: 'Greet', mode: 'direct', branchMode: 'new', workBranch: `autodev/AD-${number}`, ownerId, status: 'queued', createPrOnCompletion: false, summaryMd: 'hi' })
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

describe('GET /events/tasks', () => {
  it('needs a session', async () => {
    const res = await fetch(`${base}/events/tasks?org=${fx.org.id}`);
    expect(res.status).toBe(401);
  });

  it('refuses users who are not members of the org', async () => {
    const res = await fetch(`${base}/events/tasks?org=${fx.org.id}`, { headers: { cookie: await cookieFor(stranger.id) } });
    expect(res.status).toBe(403);
  });

  it('streams only the changes of the org the member belongs to', async () => {
    const res = await fetch(`${base}/events/tasks?org=${fx.org.id}`, { headers: { cookie: await cookieFor(dev.id) } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await deps.taskChanges.ready();

    const other = await makeOrg(deps.sys, 'globex');
    const otherTask = await taskIn(other.org.id, other.repo.id, dev.id, 1);
    const ownTask = await taskIn(fx.org.id, fx.repo.id, dev.id, 1);
    await deps.sys.insert(schema.taskEvents).values({ orgId: other.org.id, taskId: otherTask.id, actorType: 'user', actorUserId: dev.id, type: 'created' });
    await deps.sys.insert(schema.taskEvents).values({ orgId: fx.org.id, taskId: ownTask.id, actorType: 'user', actorUserId: dev.id, type: 'created' });

    const text = await readStream(res, (t) => t.includes(ownTask.id));
    expect(text).toContain('event: task');
    expect(text).toContain(ownTask.id);
    expect(text).not.toContain(otherTask.id);
  });

  it('also sends status changes made directly on the task row', async () => {
    const res = await fetch(`${base}/events/tasks?org=${fx.org.id}`, { headers: { cookie: await cookieFor(dev.id) } });
    expect(res.status).toBe(200);
    await deps.taskChanges.ready();
    const t = await taskIn(fx.org.id, fx.repo.id, dev.id, 2);
    await deps.sys.update(schema.tasks).set({ status: 'planning' }).where(eq(schema.tasks.id, t.id));

    const text = await readStream(res, (s) => s.includes(t.id));
    expect(text).toContain(t.id);
  });
});
