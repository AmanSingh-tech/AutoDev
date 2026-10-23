import { boolean, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, tsz, updatedAt } from './_shared';
import { billingPlan, subscriptionStatus } from './enums';
import { orgs } from './orgs';

/**
 * An org's paid plan (B-6), mirrored from Stripe by its webhooks. One row per org once it has
 * started a checkout; no row means the free trial (from the org's creation date). Written by the
 * API's Stripe webhook and the seat sync only.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    plan: billingPlan('plan').notNull(),
    status: subscriptionStatus('status').notNull(),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    /** The Stripe subscription item whose quantity is the seat count. */
    stripeItemId: text('stripe_item_id'),
    seats: integer('seats').notNull().default(1),
    currentPeriodEnd: tsz('current_period_end'),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    /** When a past_due subscription stops being honoured (a grace period after the first failed payment). */
    graceUntil: tsz('grace_until'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('subscriptions_stripe_subscription_uq').on(t.stripeSubscriptionId), index('subscriptions_customer_idx').on(t.stripeCustomerId)],
);

/** Stripe webhook events already handled, so a redelivery is a no-op. */
export const stripeEvents = pgTable('stripe_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: createdAt(),
});
