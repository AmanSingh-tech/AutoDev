import { and, eq, inArray, schema, type SubscriptionStatus, type SystemDb } from '@autodev/db';
import { GRACE_DAYS, planForPrice, type BillingConfig } from './state';
import type { StripeClient, StripeSubscription } from './stripe';
import type { StripeEvent } from './webhook';

const { notifications, orgMembers, orgs, stripeEvents, subscriptions } = schema;

const STATUSES: SubscriptionStatus[] = ['trialing', 'active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused'];

/**
 * Applies one Stripe webhook event. Idempotent: an event id already seen is skipped. Subscriptions
 * are always re-read from Stripe rather than trusted from the event body, so out-of-order delivery
 * ends with the latest state.
 */
export async function applyStripeEvent(deps: { sys: SystemDb; stripe: StripeClient; cfg: BillingConfig }, event: StripeEvent, now = new Date()): Promise<string> {
  const { sys } = deps;
  const [fresh] = await sys.insert(stripeEvents).values({ id: event.id, type: event.type }).onConflictDoNothing().returning();
  if (!fresh) return 'duplicate';
  try {
    const o = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed': {
        const orgId = (o.client_reference_id as string | undefined) ?? (o.metadata as Record<string, string> | undefined)?.org_id;
        if (!orgId || typeof o.subscription !== 'string') return 'ignored';
        return syncSubscription(deps, await deps.stripe.getSubscription(o.subscription), orgId, now);
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return syncSubscription(deps, await deps.stripe.getSubscription(o.id), undefined, now);
      case 'invoice.payment_failed': {
        const subId = o.subscription as string | undefined;
        if (!subId) return 'ignored';
        const [sub] = await sys.select().from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, subId));
        if (!sub) return 'ignored';
        await notifyAdmins(sys, sub.orgId, 'billing.payment_failed', 'A payment failed', `AI work keeps running for ${GRACE_DAYS} days while the payment method is updated under Settings → Billing.`);
        return 'notified';
      }
      default:
        return 'ignored';
    }
  } catch (e) {
    // Let Stripe redeliver: forget we saw it.
    await sys.delete(stripeEvents).where(eq(stripeEvents.id, event.id));
    throw e;
  }
}

/** Upserts the org's row from a Stripe subscription. The org comes from metadata, or an existing row. */
export async function syncSubscription(deps: { sys: SystemDb; cfg: BillingConfig }, s: StripeSubscription, orgIdHint: string | undefined, now = new Date()): Promise<string> {
  const { sys } = deps;
  const [existing] = await sys.select().from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, s.id));
  const orgId = orgIdHint ?? s.metadata?.org_id ?? existing?.orgId;
  if (!orgId) return 'unknown_org';
  const [org] = await sys.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId));
  if (!org) return 'unknown_org';
  const item = s.items.data[0];
  const plan = planForPrice(deps.cfg, item?.price.id) ?? existing?.plan ?? 'team';
  const status = (STATUSES.includes(s.status as SubscriptionStatus) ? s.status : 'incomplete') as SubscriptionStatus;
  const [current] = await sys.select().from(subscriptions).where(eq(subscriptions.orgId, orgId));
  // The grace period starts the first time it goes past_due and clears once it recovers.
  const graceUntil = status === 'past_due' ? (current?.graceUntil ?? new Date(now.getTime() + GRACE_DAYS * 86_400_000)) : null;
  const periodEnd = s.current_period_end ?? item?.current_period_end;
  const values = {
    plan,
    status,
    stripeCustomerId: s.customer,
    stripeSubscriptionId: s.id,
    stripeItemId: item?.id ?? null,
    seats: item?.quantity ?? 1,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
    cancelAtPeriodEnd: s.cancel_at_period_end,
    graceUntil,
    updatedAt: now,
  };
  await sys.insert(subscriptions).values({ orgId, ...values }).onConflictDoUpdate({ target: subscriptions.orgId, set: values });
  return `subscription:${status}`;
}

async function notifyAdmins(sys: SystemDb, orgId: string, type: string, title: string, body: string) {
  const [org] = await sys.select({ slug: orgs.slug }).from(orgs).where(eq(orgs.id, orgId));
  const admins = await sys
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.status, 'active'), inArray(orgMembers.role, ['owner', 'admin'])));
  if (admins.length) await sys.insert(notifications).values(admins.map((a) => ({ orgId, userId: a.userId, type, title, body, link: `/o/${org!.slug}/settings/billing` })));
}

