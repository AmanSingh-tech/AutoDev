import { encode } from '@auth/core/jwt';
import { signStripePayload } from '@autodev/billing';
import { eq, schema } from '@autodev/db';
import { makeOrg, truncateAll } from '@autodev/db/testing';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, AUTH_SECRET, callerFor, createTestDeps, msw, STRIPE } from '../../test/harness';
import { buildServer } from '../server';

const h = createTestDeps();
const { deps } = h;
const app = await buildServer(deps, { logger: false });
beforeAll(() => msw.listen({ onUnhandledRequest: 'error' }));
afterEach(() => msw.resetHandlers());
afterAll(async () => {
  msw.close();
  await app.close();
  await h.close();
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
let dev: { id: string };
beforeEach(async () => {
  await truncateAll(deps.sys);
  fx = await makeOrg(deps.sys, 'acme');
  dev = await addMember(deps, fx.org.id, 'dev', 'developer');
});

const cookieFor = async (userId: string) => `authjs.session-token=${await encode({ token: { uid: userId }, secret: AUTH_SECRET, salt: 'authjs.session-token' })}`;
const post = async (url: string, payload: object, user?: { id: string }) =>
  app.inject({ method: 'POST', url, payload, headers: user ? { cookie: await cookieFor(user.id) } : {} });
const row = async () => (await deps.sys.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, fx.org.id)))[0];

function stripeApi() {
  const calls: { path: string; body: string }[] = [];
  msw.use(
    http.post(`${STRIPE}/v1/checkout/sessions`, async ({ request }) => {
      calls.push({ path: 'checkout', body: decodeURIComponent(await request.text()) });
      return HttpResponse.json({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
    }),
    http.post(`${STRIPE}/v1/billing_portal/sessions`, async ({ request }) => {
      calls.push({ path: 'portal', body: decodeURIComponent(await request.text()) });
      return HttpResponse.json({ url: 'https://billing.stripe.test/p_1' });
    }),
    http.get(`${STRIPE}/v1/subscriptions/:id`, () =>
      HttpResponse.json({
        id: 'sub_1',
        customer: 'cus_1',
        status: 'active',
        cancel_at_period_end: false,
        current_period_end: 1_800_000_000,
        metadata: { org_id: fx.org.id },
        items: { data: [{ id: 'si_1', quantity: 2, price: { id: 'price_team' } }] },
      }),
    ),
  );
  return calls;
}

describe('POST /webhooks/stripe', () => {
  const webhook = (raw: string, signature: string) => app.inject({ method: 'POST', url: '/webhooks/stripe', payload: raw, headers: { 'content-type': 'application/json', 'stripe-signature': signature } });

  it('applies correctly signed events and rejects the rest', async () => {
    stripeApi();
    const raw = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', created: 0, data: { object: { id: 'cs_1', client_reference_id: fx.org.id, subscription: 'sub_1' } } });
    expect((await webhook(raw, signStripePayload('whsec_wrong', raw))).statusCode).toBe(400);
    expect(await row()).toBeUndefined();

    const res = await webhook(raw, signStripePayload('whsec_harness', raw));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, result: 'subscription:active' });
    expect(await row()).toMatchObject({ plan: 'team', status: 'active', seats: 2, stripeCustomerId: 'cus_1' });
    expect((await webhook(raw, signStripePayload('whsec_harness', raw))).json()).toMatchObject({ result: 'duplicate' });
  });
});

describe('POST /billing/checkout and /billing/portal', () => {
  it('sends owners to a per-seat checkout for the org, and only owners and admins', async () => {
    const calls = stripeApi();
    expect((await post('/billing/checkout', { orgId: fx.org.id, plan: 'team' })).statusCode).toBe(401);
    expect((await post('/billing/checkout', { orgId: fx.org.id, plan: 'team' }, dev)).statusCode).toBe(403);
    expect((await post('/billing/checkout', { orgId: fx.org.id, plan: 'enterprise' }, fx.owner)).statusCode).toBe(400);

    const res = await post('/billing/checkout', { orgId: fx.org.id, plan: 'business' }, fx.owner);
    expect(res.json()).toEqual({ url: 'https://checkout.stripe.test/cs_1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toContain('line_items[0][price]=price_business');
    expect(calls[0]!.body).toContain('line_items[0][quantity]=2');
    expect(calls[0]!.body).toContain(`client_reference_id=${fx.org.id}`);
    expect(calls[0]!.body).toContain('success_url=http://web.test/o/acme/settings/billing?checkout=success');
  });

  it('refuses a second checkout once there is a plan, and opens the portal instead', async () => {
    const calls = stripeApi();
    expect((await post('/billing/portal', { orgId: fx.org.id }, fx.owner)).statusCode).toBe(400);
    await deps.sys.insert(schema.subscriptions).values({ orgId: fx.org.id, plan: 'team', status: 'active', stripeCustomerId: 'cus_1' });
    expect((await post('/billing/checkout', { orgId: fx.org.id, plan: 'team' }, fx.owner)).statusCode).toBe(409);
    const res = await post('/billing/portal', { orgId: fx.org.id }, fx.owner);
    expect(res.json()).toEqual({ url: 'https://billing.stripe.test/p_1' });
    expect(calls).toEqual([{ path: 'portal', body: 'customer=cus_1&return_url=http://web.test/o/acme/settings/billing' }]);
  });
});

describe('billing gate', () => {
  it('reports the trial, and blocks starting tasks once the plan has lapsed', async () => {
    const as = callerFor(deps, fx.owner.id, fx.org.id);
    expect(await as.billing.status()).toMatchObject({ enabled: true, canRun: true, status: 'trial', members: 2, plans: [{ id: 'team', label: 'Team' }, { id: 'business', label: 'Business' }] });

    await deps.sys.insert(schema.subscriptions).values({ orgId: fx.org.id, plan: 'team', status: 'canceled' });
    const [t] = await deps.sys
      .insert(schema.tasks)
      .values({ orgId: fx.org.id, repoId: fx.repo.id, number: 1, key: 'AD-1', title: 'Fix the login redirect', descriptionMd: 'x', mode: 'direct', branchMode: 'new', workBranch: 'autodev/ad-1', ownerId: fx.owner.id, createdBy: fx.owner.id })
      .returning();
    const err = await as.tasks.start({ key: t!.key }).catch((e) => e);
    expect(err.code).toBe('PRECONDITION_FAILED');
    expect(h.agentJobs).toEqual([]);
  });
});

describe('onboarding', () => {
  it('follows the org’s data, with skips for the steps people can opt out of', async () => {
    const owner = callerFor(deps, fx.owner.id, fx.org.id);
    const steps = async () => Object.fromEntries((await owner.onboarding.status()).steps.map((s) => [s.id, s.done]));
    // makeOrg installs the App; dev makes two members.
    expect(await steps()).toEqual({ github: true, ai_key: false, models: false, team: true, builder: false, plan: false });

    await owner.onboarding.update({ modelsConfirmed: true });
    await owner.onboarding.update({ dismissed: true });
    expect(await steps()).toMatchObject({ models: true });
    expect(await owner.onboarding.status()).toMatchObject({ dismissed: true, complete: false, isAdmin: true });

    await deps.sys.insert(schema.subscriptions).values({ orgId: fx.org.id, plan: 'team', status: 'active' });
    expect(await steps()).toMatchObject({ plan: true });

    const err = await callerFor(deps, dev.id, fx.org.id).onboarding.update({ inviteSkipped: true }).catch((e) => e);
    expect(err.code).toBe('FORBIDDEN');
    expect(await callerFor(deps, dev.id, fx.org.id).onboarding.status()).toMatchObject({ isAdmin: false });
  });
});

describe('tRPC over Fastify', () => {
  it('routes long batches (every procedure name shares one path segment)', async () => {
    const names = Array.from({ length: 12 }, () => 'onboarding.status').join(',');
    const input = encodeURIComponent(JSON.stringify(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, { json: null }]))));
    const res = await app.inject({ method: 'GET', url: `/trpc/${names}?batch=1&input=${input}`, headers: { cookie: await cookieFor(fx.owner.id), 'x-org-id': fx.org.id } });
    expect(names.length).toBeGreaterThan(100);
    expect(res.statusCode).toBe(200);
  });
});
