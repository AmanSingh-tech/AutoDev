import { and, eq, schema, withOrg } from '@autodev/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { readSession } from '../auth/session';

export const HEARTBEAT_MS = 25_000;

/**
 * Server-sent events for task changes. The browser can't send x-org-id on EventSource, so the org
 * comes from the query string, and the session cookie plus an active membership are checked here.
 * Events carry only the task id; the client refetches what it shows.
 */
export async function eventRoutes(app: FastifyInstance, { deps }: { deps: Deps }) {
  app.get('/events/tasks', async (req, reply) => {
    const { org: orgId } = z.object({ org: z.string().uuid() }).parse(req.query);
    const session = await readSession(req.cookies, deps.env.AUTH_SECRET);
    if (!session) return reply.code(401).send({ error: 'not signed in' });

    const [member] = await withOrg(deps.app, orgId, session.userId, (tx) =>
      tx
        .select({ role: schema.orgMembers.role })
        .from(schema.orgMembers)
        .where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, session.userId), eq(schema.orgMembers.status, 'active'))),
    );
    if (!member) return reply.code(403).send({ error: 'Not a member of this org' });

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    raw.write('retry: 3000\n\n');

    const unsubscribe = deps.taskChanges.subscribe(orgId, (taskId) => {
      raw.write(`event: task\ndata: ${JSON.stringify({ taskId })}\n\n`);
    });
    // Keeps proxies from closing an idle stream.
    const heartbeat = setInterval(() => raw.write(': ping\n\n'), HEARTBEAT_MS);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
