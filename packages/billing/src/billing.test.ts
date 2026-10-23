import { createSystemDb, eq, schema } from '@autodev/db';
import { makeOrg, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyStripeEvent, billingState, formEncode, signStripePayload, StripeClient, StripeSignatureError, syncSeats, verifyStripeEvent, type BillingConfig, type StripeSubscription } from './index';

const sys = createSystemDb(TEST_SYSTEM_URL);
const server = setupServer();
const STRIPE = 'http://stripe.test';
const cfg: BillingConfig = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', STRIPE_PRICE_TEAM: 'price_team', STRIPE_PRICE_BUSINESS: 'price_business', STRIPE_API_URL: STRIPE, TRIAL_DAYS: 14 };
const stripe = new StripeClient({ secretKey: 'sk_test_x', apiUrl: STRIPE });
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await sys.close();
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
beforeEach(async () => {
  await truncateAll(sys.db);
  fx = await makeOrg(sys.db, 'acme');
});

/** Stripe's subscription as GET /v1/subscriptions/:id returns it; tests change `current`. */
let current: StripeSubscription;
const subscription = (o: Partial<StripeSubscription> & { quantity?: number; price?: string } = {}): StripeSubscription => ({
  id: 'sub_1',
  customer: 'cus_1',
  status: 'active',
  cancel_at_period_end: false,
  current_period_end: 1_800_000_000,
  metadata: { org_id: fx.org.id },
  items: { data: [{ id: 'si_1', quantity: o.quantity ?? 3, price: { id: o.price ?? 'price_team' } }] },
  ...o,
});
function stripeApi() {
  const calls: { path: string; body: string }[] = [];
  server.use(
    http.get(`${STRIPE}/v1/subscriptions/:id`, ({ request }) => {
      expect(request.headers.get('authorization')).toBe('Bearer sk_test_x');
      return HttpResponse.json(current);
    }),
    http.post(`${STRIPE}/v1/subscription_items/:id`, async ({ request, params }) => {
      calls.push({ path: `subscription_items/${params.id}`, body: await request.text() });
      return HttpResponse.json({ id: params.id, quantity: 2 });
    }),
  );
  return calls;
}
const event = (type: string, object: Record<string, unknown>, id = `evt_${Math.random()}`) => ({ id, type, created: 0, data: { object: { id: 'x', ...object } } });
const row = async () => (await sys.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, fx.org.id)))[0];

describe('Stripe plumbing', () => {
  it('form-encodes nested params the way Stripe expects', () => {
    expect(decodeURIComponent(formEncode({ mode: 'subscription', line_items: [{ price: 'p', quantity: 2 }], metadata: { org_id: 'o' }, skip: undefined }))).toBe(
      'mode=subscription&line_items[0][price]=p&line_items[0][quantity]=2&metadata[org_id]=o',
    );
  });

  it('accepts only correctly signed, recent webhook bodies', () => {
    const raw = JSON.stringify({ id: 'evt_1', type: 'x', created: 0, data: { object: { id: 'o' } } });
    expect(verifyStripeEvent('whsec_x', Buffer.from(raw), signStripePayload('whsec_x', raw)).id).toBe('evt_1');
    expect(() => verifyStripeEvent('whsec_x', Buffer.from(raw), signStripePayload('whsec_other', raw))).toThrow(StripeSignatureError);
    expect(() => verifyStripeEvent('whsec_x', Buffer.from(`${raw} `), signStripePayload('whsec_x', raw))).toThrow(/mismatch/);
    expect(() => verifyStripeEvent('whsec_x', Buffer.from(raw), signStripePayload('whsec_x', raw, Math.floor(Date.now() / 1000) - 3600))).toThrow(/tolerance/);
    expect(() => verifyStripeEvent('whsec_x', Buffer.from(raw), undefined)).toThrow(/missing/);
  });
});

describe('billingState', () => {
  it('is off without a Stripe key, so everything runs', async () => {
    expect(await billingState(sys.db, { ...cfg, STRIPE_SECRET_KEY: undefined }, fx.org.id)).toEqual({ enabled: false, canRun: true });
  });

  it('starts with a trial from the org’s creation, then blocks AI work until a plan is chosen', async () => {
    expect(await billingState(sys.db, cfg, fx.org.id)).toMatchObject({ canRun: true, status: 'trial', plan: null, members: 1 });
    const later = new Date(Date.now() + 15 * 86_400_000);
    expect(await billingState(sys.db, cfg, fx.org.id, later)).toMatchObject({ canRun: false, status: 'trial_ended', blockedReason: expect.stringContaining('trial has ended') });
  });

  it('honours active and trialing plans, past_due during the grace period, and enterprise', async () => {
    const set = (v: Partial<typeof schema.subscriptions.$inferInsert>) =>
      sys.db.insert(schema.subscriptions).values({ orgId: fx.org.id, plan: 'team', status: 'active', ...v }).onConflictDoUpdate({ target: schema.subscriptions.orgId, set: { plan: 'team', status: 'active', graceUntil: null, ...v } });
    await set({ status: 'active' });
    expect((await billingState(sys.db, cfg, fx.org.id)).canRun).toBe(true);
    await set({ status: 'past_due', graceUntil: new Date(Date.now() + 86_400_000) });
    expect((await billingState(sys.db, cfg, fx.org.id)).canRun).toBe(true);
    await set({ status: 'past_due', graceUntil: new Date(Date.now() - 1000) });
    expect(await billingState(sys.db, cfg, fx.org.id)).toMatchObject({ canRun: false, blockedReason: expect.stringContaining('Payment failed') });
    await set({ status: 'canceled' });
    expect((await billingState(sys.db, cfg, fx.org.id)).canRun).toBe(false);
    await set({ plan: 'enterprise', status: 'incomplete' });
    expect((await billingState(sys.db, cfg, fx.org.id)).canRun).toBe(true);
  });
});

describe('applyStripeEvent', () => {
  const deps = () => ({ sys: sys.db, stripe, cfg });

  it('links a completed checkout to the org from the subscription Stripe returns, once', async () => {
    stripeApi();
    current = subscription({ quantity: 3, price: 'price_business' });
    const e = event('checkout.session.completed', { client_reference_id: fx.org.id, subscription: 'sub_1' }, 'evt_checkout');
    expect(await applyStripeEvent(deps(), e)).toBe('subscription:active');
    expect(await row()).toMatchObject({ plan: 'business', status: 'active', seats: 3, stripeCustomerId: 'cus_1', stripeItemId: 'si_1', cancelAtPeriodEnd: false });
    expect(await applyStripeEvent(deps(), e)).toBe('duplicate');
  });

  it('starts a grace period when payment fails, keeps it on repeats, and ends it on recovery or cancellation', async () => {
    stripeApi();
    current = subscription();
    await applyStripeEvent(deps(), event('customer.subscription.created', { id: 'sub_1' }));
    current = subscription({ status: 'past_due' });
    await applyStripeEvent(deps(), event('customer.subscription.updated', { id: 'sub_1' }));
    const grace = (await row())!.graceUntil!;
    expect(grace.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    await applyStripeEvent(deps(), event('customer.subscription.updated', { id: 'sub_1' }));
    expect((await row())!.graceUntil).toEqual(grace);

    await applyStripeEvent(deps(), event('invoice.payment_failed', { subscription: 'sub_1' }));
    const notes = await sys.db.select().from(schema.notifications).where(eq(schema.notifications.type, 'billing.payment_failed'));
    expect(notes).toEqual([expect.objectContaining({ userId: fx.owner.id, link: '/o/acme/settings/billing' })]);

    current = subscription({ status: 'canceled', cancel_at_period_end: true });
    await applyStripeEvent(deps(), event('customer.subscription.deleted', { id: 'sub_1' }));
    expect(await row()).toMatchObject({ status: 'canceled', graceUntil: null, cancelAtPeriodEnd: true });
  });

  it('ignores subscriptions it can’t tie to an org, and lets Stripe redeliver after an error', async () => {
    stripeApi();
    current = subscription({ metadata: {} });
    expect(await applyStripeEvent(deps(), event('customer.subscription.created', { id: 'sub_1' }))).toBe('unknown_org');

    server.use(http.get(`${STRIPE}/v1/subscriptions/:id`, () => HttpResponse.json({ error: { message: 'down' } }, { status: 500 })));
    const e = event('customer.subscription.updated', { id: 'sub_1' }, 'evt_retry');
    await expect(applyStripeEvent(deps(), e)).rejects.toThrow('down');
    expect(await sys.db.select().from(schema.stripeEvents).where(eq(schema.stripeEvents.id, 'evt_retry'))).toEqual([]);
  });
});

describe('syncSeats', () => {
  it('sets the subscription quantity to the number of active members', async () => {
    const calls = stripeApi();
    await sys.db.insert(schema.subscriptions).values({ orgId: fx.org.id, plan: 'team', status: 'active', stripeItemId: 'si_1', seats: 5 });
    const [u] = await sys.db.insert(schema.users).values({ githubUserId: 9_600_001, githubLogin: 'dev' }).returning();
    await sys.db.insert(schema.orgMembers).values({ orgId: fx.org.id, userId: u!.id, role: 'developer' });
    expect(await syncSeats({ sys: sys.db, stripe }, fx.org.id)).toEqual({ from: 5, to: 2 });
    expect(calls).toEqual([{ path: 'subscription_items/si_1', body: 'quantity=2&proration_behavior=create_prorations' }]);
    expect((await row())!.seats).toBe(2);
    expect(await syncSeats({ sys: sys.db, stripe }, fx.org.id)).toBeNull();
  });
});
