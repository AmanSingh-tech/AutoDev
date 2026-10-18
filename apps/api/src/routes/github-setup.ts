import { GitHubReauthRequired } from '@autodev/github';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readSession } from '../auth/session';
import type { Deps } from '../deps';
import { linkInstallation } from '../services/link-installation';

const query = z.object({
  installation_id: z.coerce.number().int().positive(),
  setup_action: z.enum(['install', 'update', 'request']).optional(),
});

/** Configure as the GitHub App "Setup URL": {WEB_URL}/api/github/setup (Next proxies to here). */
export async function githubSetupRoutes(app: FastifyInstance, { deps }: { deps: Deps }) {
  app.get('/github/setup', async (req, reply) => {
    const web = deps.env.WEB_URL;
    const parsed = query.safeParse(req.query);
    if (!parsed.success) return reply.redirect(`${web}/setup/error?reason=bad_request`);

    const session = await readSession(req.cookies, deps.env.AUTH_SECRET);
    if (!session) {
      const back = `${web}/api/github/setup?installation_id=${parsed.data.installation_id}`;
      return reply.redirect(`${web}/login?callbackUrl=${encodeURIComponent(back)}`);
    }
    if (parsed.data.setup_action === 'request') {
      // A non-admin asked their org owner to install. Nothing to link yet.
      return reply.redirect(`${web}/setup/requested`);
    }

    try {
      const res = await linkInstallation(deps, session.userId, parsed.data.installation_id);
      return res.ok
        ? reply.redirect(`${web}/o/${res.orgSlug}/repos${res.created ? '?welcome=1' : ''}`)
        : reply.redirect(`${web}/setup/error?reason=${res.reason}`);
    } catch (e) {
      if (e instanceof GitHubReauthRequired) return reply.redirect(`${web}/login`);
      throw e;
    }
  });
}
