import { eq, ORG_ROLES, schema, sql } from '@autodev/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { codeIndexEnabled } from '../../services/code-index';
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
    /** Store a searchable index of the code (B-2). Turning it off deletes the index. Kept in `orgs.settings`. */
    storeCodeIndex: z.boolean(),
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
  settings: orgs.settings,
};

/** Settings kept in the `settings` JSON, shown as plain fields. */
function present<T extends { settings: Record<string, unknown> }>(row: T) {
  const { settings, ...rest } = row;
  return { ...rest, storeCodeIndex: codeIndexEnabled(settings) };
}

export const orgsRouter = router({
  /** The current org's settings plus the caller's role. Never includes key material. */
  current: orgProcedure.query(async ({ ctx }) => {
    const [org] = await ctx.inOrg((tx) => tx.select(publicOrgColumns).from(orgs).where(eq(orgs.id, ctx.orgId)));
    if (!org) throw new TRPCError({ code: 'NOT_FOUND' });
    return { ...present(org), myRole: ctx.role };
  }),

  updateSettings: adminProcedure.input(settingsInput).mutation(async ({ ctx, input }) => {
    const { storeCodeIndex, ...columns } = input;
    const result = await ctx.inOrg(async (tx) => {
      const [beforeRow] = await tx.select(publicOrgColumns).from(orgs).where(eq(orgs.id, ctx.orgId));
      const set = {
        ...columns,
        ...(storeCodeIndex === undefined ? {} : { settings: sql`${orgs.settings} || ${JSON.stringify({ storeCodeIndex })}::jsonb` }),
      };
      const [afterRow] = await tx.update(orgs).set(set).where(eq(orgs.id, ctx.orgId)).returning(publicOrgColumns);
      const before = beforeRow && present(beforeRow);
      const after = afterRow && present(afterRow);
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
      return { before: before!, after: after! };
    });
    // Turning the index on builds it for every repo; turning it off deletes it (both in the worker).
    if (!result.before.storeCodeIndex && result.after.storeCodeIndex) await ctx.deps.queues.codeIndex.add('org', { kind: 'org', orgId: ctx.orgId });
    if (result.before.storeCodeIndex && !result.after.storeCodeIndex) await ctx.deps.queues.codeIndex.add('purge', { kind: 'purge', orgId: ctx.orgId });
    return result.after;
  }),
});
