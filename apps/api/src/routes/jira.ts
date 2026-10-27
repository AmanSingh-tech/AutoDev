import { applyJiraWebhook } from '@autodev/jira';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';

/**
 * POST /webhooks/jira/:org/:token (B-7). Jira Cloud webhooks aren't signed, so the URL carries a
 * per-org secret token (shown to admins under Settings → Jira). Issue updates keep the issue's
 * status on linked tasks; deleted issues are unlinked.
 */
export async function jiraRoutes(app: FastifyInstance, { deps }: { deps: Deps }) {
  app.post('/webhooks/jira/:org/:token', async (req, reply) => {
    const p = z.object({ org: z.string().uuid(), token: z.string().min(16).max(64) }).safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'not found' });
    const result = await applyJiraWebhook(deps.sys, p.data.org, p.data.token, (req.body ?? {}) as Parameters<typeof applyJiraWebhook>[3]);
    if (result === 'forbidden') return reply.code(404).send({ error: 'not found' });
    return reply.send({ received: true, result });
  });
}
