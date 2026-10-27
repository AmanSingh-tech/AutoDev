import { isAfter, replayAfter, STREAM_ID } from '@autodev/events';
import { parseTopics, type EventEnvelope, type Topic } from '@autodev/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkOrgAccess } from '../auth/org-access';
import { readSession } from '../auth/session';
import type { Deps } from '../deps';
import { authorizeTopics, TopicDenied } from '../events/authz';

export const HEARTBEAT_MS = 15_000;

/**
 * One SSE stream per tab: GET /events?org=<id>&topics=repo:<id>,user:<id>,…
 *
 * EventSource can't send headers, so the org comes from the query string; the session cookie and
 * every topic are checked before the stream opens. On reconnect the browser sends Last-Event-ID
 * and the stream replays what was missed from the org's Redis stream, then continues live.
 */
export async function eventRoutes(app: FastifyInstance, { deps }: { deps: Deps }) {
  app.get('/events', async (req, reply) => {
    const query = z
      .object({
        org: z.string().uuid(),
        topics: z.string().min(1).max(2000),
        /** For a stream reopened with new topics: a new EventSource can't send Last-Event-ID. */
        lastEventId: z.string().max(64).optional(),
      })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'org and topics are required' });
    let topics: Topic[];
    try {
      topics = parseTopics(query.data.topics);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : 'invalid topics' });
    }
    const orgId = query.data.org;

    const session = await readSession(req.cookies, deps.env.AUTH_SECRET);
    if (!session) return reply.code(401).send({ error: 'not signed in' });
    const access = await checkOrgAccess(deps.app, { orgId, userId: session.userId, ip: req.ip, region: deps.env.DATA_REGION, sys: deps.sys });
    if (!access.ok) return reply.code(403).send({ error: access.message });
    try {
      await authorizeTopics(deps, orgId, session.userId, topics);
    } catch (e) {
      if (e instanceof TopicDenied) return reply.code(403).send({ error: e.message });
      throw e;
    }

    const wanted = new Set<string>(topics);
    const header = req.headers['last-event-id'];
    const resumeFrom = typeof header === 'string' ? header : query.data.lastEventId;
    const lastEventId = resumeFrom && STREAM_ID.test(resumeFrom) ? resumeFrom : null;

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      // HTTP/2 forbids connection-specific headers; HTTP/1.1 needs keep-alive for a stream.
      ...(req.raw.httpVersionMajor === 1 ? { connection: 'keep-alive' } : {}),
    });
    raw.write('retry: 3000\n\n');

    let lastSent = lastEventId;
    const send = (env: EventEnvelope) => {
      if (!wanted.has(env.topic)) return;
      if (lastSent && !isAfter(env.id, lastSent)) return;
      raw.write(`id: ${env.id}\ndata: ${JSON.stringify(env)}\n\n`);
      lastSent = env.id;
    };

    // Subscribe before replaying, and hold live events until the replay is written, so the
    // stream has no gap and no duplicates.
    let replaying = true;
    const held: EventEnvelope[] = [];
    const unsubscribe = await deps.events.subscribe(orgId, (env) =>
      replaying ? held.push(env) : send(env),
    );
    const heartbeat = setInterval(() => raw.write(': ping\n\n'), HEARTBEAT_MS);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    if (lastEventId) for (const env of await replayAfter(deps.redis, orgId, lastEventId)) send(env);
    for (const env of held) send(env);
    replaying = false;
  });
}
