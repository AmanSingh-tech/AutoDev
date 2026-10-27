import { eq, schema } from '@autodev/db';
import { applyWorkosEvent, linkIdentity, readState, signState, SsoLinkError, verifyWorkosWebhook, WorkosError, WorkosSignatureError } from '@autodev/sso';
import { syncSeats } from '@autodev/billing';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkOrgAccess } from '../auth/org-access';
import { readSession } from '../auth/session';
import type { Deps } from '../deps';

const { orgs, orgSso } = schema;

/** Only paths inside the app, so the callback can't be used as an open redirect. */
const safeReturn = (p: string | undefined, slug: string) => (p && /^\/o\/[a-z0-9-]+(\/[\w\-./?=&%]*)?$/i.test(p) && !p.includes('//') ? p : `/o/${slug}`);

/**
 * Single sign-on and directory sync through WorkOS (B-7), reached by the browser through the web
 * app's /api/sso proxy:
 *   GET  /sso/start?org=…&returnTo=…  → the org's identity provider
 *   GET  /sso/callback?code=…&state=… → links the IdP account to the signed-in user, then back
 *   POST /webhooks/workos             → directory sync events (signature checked)
 */
export async function ssoRoutes(app: FastifyInstance, { deps }: { deps: Deps }) {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  const { workos, cfg } = deps.sso;
  const redirectUri = `${deps.env.WEB_URL}/api/sso/callback`;
  const page = (slug: string | null, error: string) => `${deps.env.WEB_URL}${slug ? `/o/${slug}` : '/orgs'}?sso_error=${encodeURIComponent(error)}`;

  app.get('/sso/start', async (req, reply) => {
    if (!workos) return reply.code(404).send({ error: 'Single sign-on isn’t set up on this server' });
    const q = z.object({ org: z.string().uuid(), returnTo: z.string().max(500).optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'org is required' });
    const session = await readSession(req.cookies, deps.env.AUTH_SECRET);
    if (!session) return reply.redirect(`${deps.env.WEB_URL}/login`);
    // Membership, region and IP still apply; SSO itself obviously can't be required here.
    const access = await checkOrgAccess(deps.app, { orgId: q.data.org, userId: session.userId, ip: req.ip, region: deps.env.DATA_REGION, skipSso: true });
    if (!access.ok) return reply.code(403).send({ error: access.message });
    const [row] = await deps.sys.select({ slug: orgs.slug, workosOrg: orgSso.workosOrganizationId }).from(orgs).leftJoin(orgSso, eq(orgSso.orgId, orgs.id)).where(eq(orgs.id, q.data.org));
    if (!row?.workosOrg) return reply.redirect(page(row?.slug ?? null, 'SSO isn’t set up for this organization yet'));
    const state = signState(deps.env.AUTH_SECRET, { orgId: q.data.org, userId: session.userId, returnTo: safeReturn(q.data.returnTo, row.slug) });
    return reply.redirect(workos.authorizationUrl({ organization: row.workosOrg, redirectUri, state }));
  });

  app.get('/sso/callback', async (req, reply) => {
    if (!workos) return reply.code(404).send({ error: 'Single sign-on isn’t set up on this server' });
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    const state = q.state ? readState(deps.env.AUTH_SECRET, q.state) : null;
    if (!state) return reply.redirect(page(null, 'The sign-in link expired. Try again.'));
    const [org] = await deps.sys.select({ slug: orgs.slug }).from(orgs).where(eq(orgs.id, state.orgId));
    const slug = org?.slug ?? null;
    if (q.error || !q.code) return reply.redirect(page(slug, q.error_description ?? 'Sign-in was cancelled'));
    // The state names the user who started; the browser finishing must be the same person.
    const session = await readSession(req.cookies, deps.env.AUTH_SECRET);
    if (!session || session.userId !== state.userId) return reply.redirect(page(slug, 'Sign in to AutoDev as the same person who started single sign-on'));
    try {
      const profile = await workos.profile(q.code);
      await linkIdentity(deps.sys, { orgId: state.orgId, userId: state.userId, profile, ip: req.ip });
    } catch (e) {
      if (e instanceof SsoLinkError || e instanceof WorkosError) return reply.redirect(page(slug, e.message));
      throw e;
    }
    return reply.redirect(`${deps.env.WEB_URL}${state.returnTo}`);
  });

  app.post('/webhooks/workos', async (req, reply) => {
    if (!cfg.WORKOS_WEBHOOK_SECRET) return reply.code(404).send({ error: 'directory sync is not set up' });
    let event;
    try {
      event = verifyWorkosWebhook(cfg.WORKOS_WEBHOOK_SECRET, req.body as Buffer, req.headers['workos-signature'] as string | undefined);
    } catch (e) {
      if (e instanceof WorkosSignatureError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    const stripe = deps.billing.stripe;
    const result = await applyWorkosEvent({ sys: deps.sys, onRemoved: stripe ? (orgId) => syncSeats({ sys: deps.sys, stripe }, orgId) : undefined }, event);
    req.log.info({ type: event.event, id: event.id, result }, 'workos webhook');
    return reply.send({ received: true, result });
  });
}
