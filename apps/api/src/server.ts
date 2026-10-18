import cookie from '@fastify/cookie';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { readSession } from './auth/session';
import type { Deps } from './deps';
import { githubSetupRoutes } from './routes/github-setup';
import { webhookRoutes } from './routes/webhooks';
import { appRouter, type AppRouter } from './trpc/router';
import type { Context } from './trpc/trpc';

export async function buildServer(deps: Deps, opts: FastifyServerOptions = {}) {
  const app = Fastify({
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
    ...opts,
    logger:
      opts.logger === false
        ? false
        : {
            level: process.env.LOG_LEVEL ?? 'info',
            // Never log credentials or signatures.
            redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-hub-signature-256"]'],
          },
  });

  await app.register(cookie);
  app.get('/healthz', async () => ({ ok: true }));

  await app.register(webhookRoutes, { deps });
  await app.register(githubSetupRoutes, { deps });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: async ({ req }): Promise<Context> => {
        const session = await readSession(req.cookies, deps.env.AUTH_SECRET);
        const orgHeader = req.headers['x-org-id'];
        return {
          deps,
          userId: session?.userId ?? null,
          orgId: typeof orgHeader === 'string' ? orgHeader : null,
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        };
      },
      onError: ({ error, path }) => {
        if (error.code === 'INTERNAL_SERVER_ERROR') app.log.error({ err: error, path }, 'trpc error');
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
  });

  return app;
}
