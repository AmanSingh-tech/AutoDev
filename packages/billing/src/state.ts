import { and, count, eq, schema, type BillingPlan, type SystemDb } from '@autodev/db';

const { orgMembers, orgs, subscriptions } = schema;

/** What the deployment's Stripe settings allow. Billing is off without a secret key. */
export interface BillingConfig {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_TEAM?: string;
  STRIPE_PRICE_BUSINESS?: string;
  STRIPE_API_URL: string;
  TRIAL_DAYS: number;
}

export const billingEnabled = (c: BillingConfig) => !!c.STRIPE_SECRET_KEY;

export const PLAN_LABEL: Record<BillingPlan, string> = { team: 'Team', business: 'Business', enterprise: 'Enterprise' };
/** Plans you can buy at checkout; Enterprise is arranged directly. */
export const SELF_SERVE_PLANS = ['team', 'business'] as const;
export type SelfServePlan = (typeof SELF_SERVE_PLANS)[number];

export function priceFor(c: BillingConfig, plan: SelfServePlan): string | undefined {
  return plan === 'team' ? c.STRIPE_PRICE_TEAM : c.STRIPE_PRICE_BUSINESS;
}
export function planForPrice(c: BillingConfig, priceId: string | undefined): BillingPlan | null {
  if (priceId && priceId === c.STRIPE_PRICE_TEAM) return 'team';
  if (priceId && priceId === c.STRIPE_PRICE_BUSINESS) return 'business';
  return null;
}

/** Days a past_due subscription keeps working after the first failed payment. */
export const GRACE_DAYS = 7;

export type BillingState =
  | { enabled: false; canRun: true }
  | {
      enabled: true;
      canRun: boolean;
      /** Why AI work is blocked, in words for the person who hits it. */
      blockedReason: string | null;
      plan: BillingPlan | null;
      status: 'trial' | 'trial_ended' | string;
      trialEndsAt: Date | null;
      seats: number;
      members: number;
      currentPeriodEnd: Date | null;
      cancelAtPeriodEnd: boolean;
      graceUntil: Date | null;
      hasCustomer: boolean;
    };

/** Active members are seats: everyone who can sign in to the org. */
export async function seatCount(sys: SystemDb, orgId: string): Promise<number> {
  const [r] = await sys.select({ n: count() }).from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.status, 'active')));
  return Number(r?.n ?? 0);
}

/**
 * Whether the org may start AI work, and what to show on the billing page. Without a subscription
 * the org is on its trial (TRIAL_DAYS from creation). Nothing is ever deleted when a plan lapses;
 * only starting new AI work is refused.
 */
export async function billingState(sys: SystemDb, c: BillingConfig, orgId: string, now = new Date()): Promise<BillingState> {
  if (!billingEnabled(c)) return { enabled: false, canRun: true };
  const [org] = await sys.select({ createdAt: orgs.createdAt }).from(orgs).where(eq(orgs.id, orgId));
  const [sub] = await sys.select().from(subscriptions).where(eq(subscriptions.orgId, orgId));
  const members = await seatCount(sys, orgId);
  const trialEndsAt = org ? new Date(org.createdAt.getTime() + c.TRIAL_DAYS * 86_400_000) : null;
  if (!sub) {
    const inTrial = !!trialEndsAt && now < trialEndsAt;
    return {
      enabled: true,
      canRun: inTrial,
      blockedReason: inTrial ? null : 'The free trial has ended. An admin can choose a plan under Settings → Billing.',
      plan: null,
      status: inTrial ? 'trial' : 'trial_ended',
      trialEndsAt,
      seats: members,
      members,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      graceUntil: null,
      hasCustomer: false,
    };
  }
  const graceOk = sub.status === 'past_due' && (!sub.graceUntil || now < sub.graceUntil);
  const canRun = sub.status === 'active' || sub.status === 'trialing' || graceOk || (sub.plan === 'enterprise' && sub.status !== 'canceled');
  const blockedReason = canRun
    ? null
    : sub.status === 'past_due'
      ? 'Payment failed and the grace period is over. An admin can update the payment method under Settings → Billing.'
      : sub.status === 'canceled'
        ? 'The subscription was cancelled. An admin can choose a plan under Settings → Billing.'
        : 'The subscription is not active yet. An admin can finish it under Settings → Billing.';
  return {
    enabled: true,
    canRun,
    blockedReason,
    plan: sub.plan,
    status: sub.status,
    trialEndsAt: null,
    seats: sub.seats,
    members,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    graceUntil: sub.graceUntil,
    hasCustomer: !!sub.stripeCustomerId,
  };
}

