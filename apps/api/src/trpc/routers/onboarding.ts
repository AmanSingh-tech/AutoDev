import { billingState } from '@autodev/billing';
import { and, eq, isNull, schema, sql } from '@autodev/db';
import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';

const { builders, installations, llmCredentials, modelPolicies, orgMembers, orgs } = schema;

/** Choices people make by hand, kept in orgs.settings.onboarding. Everything else is read from the data. */
type Flags = { modelsConfirmed?: boolean; inviteSkipped?: boolean; dismissed?: boolean };

export const ONBOARDING_STEPS = ['github', 'ai_key', 'models', 'team', 'builder', 'plan'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/**
 * The first-run checklist (B-6). Each step is done when the org's data says so, so the list stays
 * right even when people skip ahead (e.g. add a key from Settings directly).
 */
export const onboardingRouter = router({
  status: orgProcedure.query(async ({ ctx }) => {
    const { sys } = ctx.deps;
    const orgId = ctx.orgId;
    const exists = async (q: Promise<unknown[]>) => (await q).length > 0;
    const [org] = await sys.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, orgId));
    const flags = ((org?.settings ?? {}) as { onboarding?: Flags }).onboarding ?? {};
    const [github, aiKey, models, builder, [members], billing] = await Promise.all([
      exists(sys.select({ id: installations.id }).from(installations).where(and(eq(installations.orgId, orgId), isNull(installations.deletedAt))).limit(1)),
      exists(sys.select({ id: llmCredentials.id }).from(llmCredentials).where(and(eq(llmCredentials.orgId, orgId), eq(llmCredentials.status, 'active'))).limit(1)),
      exists(sys.select({ id: modelPolicies.id }).from(modelPolicies).where(eq(modelPolicies.orgId, orgId)).limit(1)),
      exists(sys.select({ id: builders.id }).from(builders).where(and(eq(builders.orgId, orgId), isNull(builders.revokedAt))).limit(1)),
      sys.select({ n: sql<number>`count(*)::int` }).from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.status, 'active'))),
      billingState(sys, ctx.deps.billing.cfg, orgId),
    ]);
    const done: Record<OnboardingStep, boolean | null> = {
      github,
      ai_key: aiKey,
      models: models || !!flags.modelsConfirmed,
      team: (members?.n ?? 0) > 1 || !!flags.inviteSkipped,
      builder,
      // Only when billing is on; null means the step doesn't apply.
      plan: billing.enabled ? !!billing.plan && billing.status !== 'canceled' : null,
    };
    const steps = ONBOARDING_STEPS.filter((s) => done[s] !== null).map((id) => ({ id, done: !!done[id] }));
    return { steps, complete: steps.every((s) => s.done), dismissed: !!flags.dismissed, isAdmin: ctx.role === 'owner' || ctx.role === 'admin' };
  }),

  update: adminProcedure
    .input(z.object({ modelsConfirmed: z.boolean().optional(), inviteSkipped: z.boolean().optional(), dismissed: z.boolean().optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      await ctx.inOrg(async (tx) => {
        await tx
          .update(orgs)
          .set({ settings: sql`jsonb_set(${orgs.settings}, '{onboarding}', coalesce(${orgs.settings} -> 'onboarding', '{}'::jsonb) || ${JSON.stringify(input)}::jsonb)` })
          .where(eq(orgs.id, ctx.orgId));
        await ctx.audit(tx, { action: 'org.onboarding_updated', targetType: 'org', targetId: ctx.orgId, metadata: input });
      });
      return { ok: true };
    }),
});
