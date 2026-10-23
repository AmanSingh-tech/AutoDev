import { eq, isNotNull, schema, type SystemDb } from '@autodev/db';
import { seatCount } from './state';
import type { StripeClient } from './stripe';

const { subscriptions } = schema;

/**
 * Seats follow active members: when they differ from the subscription's quantity, Stripe is updated
 * (prorated). Enterprise plans are invoiced directly and left alone.
 */
export async function syncSeats(deps: { sys: SystemDb; stripe: StripeClient }, orgId: string): Promise<{ from: number; to: number } | null> {
  const [sub] = await deps.sys.select().from(subscriptions).where(eq(subscriptions.orgId, orgId));
  if (!sub?.stripeItemId || sub.plan === 'enterprise' || sub.status === 'canceled') return null;
  const members = Math.max(1, await seatCount(deps.sys, orgId));
  if (members === sub.seats) return null;
  await deps.stripe.setQuantity(sub.stripeItemId, members);
  await deps.sys.update(subscriptions).set({ seats: members, updatedAt: new Date() }).where(eq(subscriptions.orgId, orgId));
  return { from: sub.seats, to: members };
}

/** Every org with a Stripe subscription (the nightly reconcile). */
export async function syncAllSeats(deps: { sys: SystemDb; stripe: StripeClient }) {
  const orgs = await deps.sys.select({ orgId: subscriptions.orgId }).from(subscriptions).where(isNotNull(subscriptions.stripeItemId));
  const changed: Record<string, { from: number; to: number }> = {};
  for (const { orgId } of orgs) {
    const r = await syncSeats(deps, orgId).catch(() => null);
    if (r) changed[orgId] = r;
  }
  return changed;
}
