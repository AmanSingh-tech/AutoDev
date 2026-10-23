import { billingState, PLAN_LABEL, priceFor, SELF_SERVE_PLANS, syncSeats } from '@autodev/billing';
import { TRPCError } from '@trpc/server';
import { billingProcedure, orgProcedure, roleAtLeast, router } from '../trpc';

/**
 * Billing status for the settings page and banners (B-6). Checkout and the billing portal are
 * REST endpoints (routes/billing.ts), because they hand the browser to Stripe.
 */
export const billingRouter = router({
  status: orgProcedure.query(async ({ ctx }) => {
    const { cfg } = ctx.deps.billing;
    const state = await billingState(ctx.deps.sys, cfg, ctx.orgId);
    return {
      ...state,
      canManage: roleAtLeast(ctx.role, 'admin') || ctx.billingManager,
      plans: state.enabled ? SELF_SERVE_PLANS.filter((p) => !!priceFor(cfg, p)).map((p) => ({ id: p, label: PLAN_LABEL[p] })) : [],
    };
  }),

  /** Seats follow active members nightly; this does it now (e.g. right after removing people). */
  syncSeats: billingProcedure.mutation(async ({ ctx }) => {
    const stripe = ctx.deps.billing.stripe;
    if (!stripe) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Billing is not set up on this server' });
    const changed = await syncSeats({ sys: ctx.deps.sys, stripe }, ctx.orgId);
    await ctx.inOrg((tx) => ctx.audit(tx, { action: 'billing.seats_synced', targetType: 'org', targetId: ctx.orgId, metadata: changed ?? {} }));
    return changed;
  }),
});
