import { verifyWebhookSignature } from '@autodev/github';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps';
import { handleWebhook } from '../webhooks/handlers';

const DEDUPE_TTL_SECONDS = 3 * 24 * 3600;

export async function webhookRoutes(app: FastifyInstance, { deps }: { deps: Deps }) {
  // Keep the raw body so the HMAC is computed over exactly what GitHub signed.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/webhooks/github', async (req, reply) => {
    const raw = req.body as Buffer;
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!Buffer.isBuffer(raw) || !verifyWebhookSignature(deps.cfg.webhookSecret, raw, signature)) {
      return reply.code(401).send({ error: 'invalid signature' });
    }
    const event = req.headers['x-github-event'];
    const delivery = req.headers['x-github-delivery'];
    if (typeof event !== 'string' || typeof delivery !== 'string') {
      return reply.code(400).send({ error: 'missing GitHub headers' });
    }

    const dedupeKey = `gh:delivery:${delivery}`;
    if (!(await deps.cache.setIfAbsent(dedupeKey, '1', DEDUPE_TTL_SECONDS))) {
      return reply.code(200).send({ result: 'duplicate' });
    }
    try {
      const result = await handleWebhook(deps, event, JSON.parse(raw.toString('utf8')));
      req.log.info({ event, delivery, result }, 'github webhook');
      return reply.code(200).send({ result });
    } catch (err) {
      // Release the dedupe key so GitHub's redelivery can be processed again.
      await deps.cache.del(dedupeKey);
      throw err;
    }
  });
}
