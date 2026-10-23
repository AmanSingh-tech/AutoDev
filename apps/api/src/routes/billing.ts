import { applyStripeEvent, billingState, PLAN_LABEL, priceFor, SELF_SERVE_PLANS, seatCount, StripeError, StripeSignatureError, verifyStripeEvent, type SelfServePlan } from '@autodev/billing';
import { eq, schema } from '@autodev/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { checkOrgAccess } from '../auth/org-access';
import { readSession } from '../auth/session';
import type { Deps } from '../deps';

const { orgs, subscriptions, users } = schema;

/**
 * Billing over plain HTTP (B-6), as the brief names it:
 *   POST /webhooks/stripe   Stripe's events (signature checked over the raw body)
 *   POST /billing/checkout  { orgId, plan } → { url } of a Stripe Checkout page (owners and admins)
 *   POST /billing/portal    { orgId } → { url } of Stripe's billing portal (owners and admins)
 * The web app reaches the last two through its /api/billing proxy, with the session cookie.
 */
export async function billingRoutes(app: FastifyInstance, { deps }: { deps: Deps }) {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  const { cfg, stripe } = deps.billing;

  app.post('/webhooks/stripe', async (req, reply) => {
    if (!stripe || !cfg.STRIPE_WEBHOOK_SECRET) return reply.code(404).send({ error: 'billing is not set up' });
    let event;
    try {
      event = verifyStripeEvent(cfg.STRIPE_WEBHOOK_SECRET, req.body as Buffer, req.headers['stripe-signature'] as string | undefined);
    } catch (e) {
      if (e instanceof StripeSignatureError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    const result = await applyStripeEvent({ sys: deps.sys, stripe, cfg }, event);
    req.log.info({ type: event.type, id: event.id, result }, 'stripe webhook');
    return reply.send({ received: true, result });
  });

  /** The signed-in owner, admin or billing manager of `orgId`, or a reply already sent. */
  async function admin(req: FastifyRequest, reply: FastifyReply): Promise<{ userId: string; orgId: string; body: Record<string, unknown> } | null> {
    const session = await readSession(req.cookies, deps.env.AUTH_SECRET);
    if (!session) return void reply.code(401).send({ error: 'Sign in first' }), null;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((req.body as Buffer | undefined)?.toString('utf8') || '{}') as Record<string, unknown>;
    } catch {
      return void reply.code(400).send({ error: 'Invalid JSON' }), null;
    }
    const orgId = typeof body.orgId === 'string' && /^[0-9a-f-]{36}$/i.test(body.orgId) ? body.orgId : '';
    const access = orgId ? await checkOrgAccess(deps.app, { orgId, userId: session.userId, ip: req.ip, region: deps.env.DATA_REGION }) : null;
    if (access && !access.ok && access.reason !== 'not_member') return void reply.code(403).send({ error: access.message }), null;
    // Owners, admins and billing managers (B-7).
    if (!access?.ok || !(access.role === 'owner' || access.role === 'admin' || access.billingManager))
      return void reply.code(403).send({ error: 'Only owners, admins and billing managers manage billing' }), null;
    return { userId: session.userId, orgId, body };
  }

  app.post('/billing/checkout', async (req, reply) => {
    if (!stripe) return reply.code(404).send({ error: 'Billing is not set up on this server' });
    const who = await admin(req, reply);
    if (!who) return;
    const plan = who.body.plan as SelfServePlan;
    if (!SELF_SERVE_PLANS.includes(plan)) return reply.code(400).send({ error: 'Choose Team or Business; Enterprise is arranged with us directly' });
    const priceId = priceFor(cfg, plan);
    if (!priceId) return reply.code(400).send({ error: `The ${PLAN_LABEL[plan]} plan isn't available on this server` });
    const state = await billingState(deps.sys, cfg, who.orgId);
    if (state.enabled && state.plan && state.status !== 'canceled' && state.status !== 'incomplete_expired')
      return reply.code(409).send({ error: 'This organization already has a plan. Change it in the billing portal.' });
    const [org] = await deps.sys.select({ slug: orgs.slug }).from(orgs).where(eq(orgs.id, who.orgId));
    const [sub] = await deps.sys.select({ customer: subscriptions.stripeCustomerId }).from(subscriptions).where(eq(subscriptions.orgId, who.orgId));
    const [user] = await deps.sys.select({ email: users.email }).from(users).where(eq(users.id, who.userId));
    const back = `${deps.env.WEB_URL}/o/${org!.slug}/settings/billing`;
    try {
      const session = await stripe.createCheckoutSession({
        orgId: who.orgId,
        priceId,
        seats: Math.max(1, await seatCount(deps.sys, who.orgId)),
        customerId: sub?.customer ?? null,
        email: user?.email ?? null,
        successUrl: `${back}?checkout=success`,
        cancelUrl: `${back}?checkout=cancelled`,
      });
      return reply.send({ url: session.url });
    } catch (e) {
      if (e instanceof StripeError) return reply.code(502).send({ error: `Stripe: ${e.message}` });
      throw e;
    }
  });

  app.post('/billing/portal', async (req, reply) => {
    if (!stripe) return reply.code(404).send({ error: 'Billing is not set up on this server' });
    const who = await admin(req, reply);
    if (!who) return;
    const [sub] = await deps.sys.select({ customer: subscriptions.stripeCustomerId }).from(subscriptions).where(eq(subscriptions.orgId, who.orgId));
    if (!sub?.customer) return reply.code(400).send({ error: 'There is no billing account yet. Choose a plan first.' });
    const [org] = await deps.sys.select({ slug: orgs.slug }).from(orgs).where(eq(orgs.id, who.orgId));
    try {
      const portal = await stripe.createPortalSession(sub.customer, `${deps.env.WEB_URL}/o/${org!.slug}/settings/billing`);
      return reply.send({ url: portal.url });
    } catch (e) {
      if (e instanceof StripeError) return reply.code(502).send({ error: `Stripe: ${e.message}` });
      throw e;
    }
  });
}
