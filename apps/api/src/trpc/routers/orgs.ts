import { eq, ORG_ROLES, schema } from '@autodev/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';

const { orgs } = schema;

const settingsInput = z
  .object({
    defaultTaskMode: z.enum(['plan_lld', 'plan_only', 'direct']),
    staleBranchDays: z.number().int().min(1).max(90),
    staleBranchAction: z.enum(['auto_open_pr', 'notify_owner']),
    defaultMemberRole: z.enum(ORG_ROLES).exclude(['owner']),
    maxFixCycles: z.number().int().min(0).max(10),
    /** Builder logs. Shorter is cheaper; longer helps debugging old failures. */
    logRetentionDays: z.number().int().min(7).max(365),
    /** Workspace snapshots of finished tasks. Patches are always kept. */
    snapshotRetentionDays: z.number().int().min(1).max(90),
    taskKeyPrefix: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/, '2–10 uppercase letters or digits'),
    allowUserKeys: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const publicOrgColumns = {
  id: orgs.id,
  name: orgs.name,
  slug: orgs.slug,
  githubLogin: orgs.githubLogin,
  accountType: orgs.accountType,
  defaultTaskMode: orgs.defaultTaskMode,
  staleBranchDays: orgs.staleBranchDays,
  staleBranchAction: orgs.staleBranchAction,
  defaultMemberRole: orgs.defaultMemberRole,
  maxFixCycles: orgs.maxFixCycles,
  logRetentionDays: orgs.logRetentionDays,
  snapshotRetentionDays: orgs.snapshotRetentionDays,
  taskKeyPrefix: orgs.taskKeyPrefix,
  allowUserKeys: orgs.allowUserKeys,
};

export const orgsRouter = router({
  /** The current org's settings plus the caller's role. Never includes key material. */
  current: orgProcedure.query(async ({ ctx }) => {
    const [org] = await ctx.inOrg((tx) => tx.select(publicOrgColumns).from(orgs).where(eq(orgs.id, ctx.orgId)));
    if (!org) throw new TRPCError({ code: 'NOT_FOUND' });
    return { ...org, myRole: ctx.role };
  }),

  updateSettings: adminProcedure.input(settingsInput).mutation(({ ctx, input }) =>
    ctx.inOrg(async (tx) => {
      const [before] = await tx.select(publicOrgColumns).from(orgs).where(eq(orgs.id, ctx.orgId));
      const [after] = await tx.update(orgs).set(input).where(eq(orgs.id, ctx.orgId)).returning(publicOrgColumns);
      await ctx.audit(tx, {
        action: 'org.settings_updated',
        targetType: 'org',
        targetId: ctx.orgId,
        metadata: {
          changes: Object.fromEntries(
            Object.keys(input).map((k) => [k, { from: before?.[k as keyof typeof before], to: after?.[k as keyof typeof after] }]),
          ),
        },
      });
      return after!;
    }),
  ),
});
