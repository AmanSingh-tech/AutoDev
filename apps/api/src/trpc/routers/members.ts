import { and, asc, eq, ORG_ROLES, schema, sql, type OrgRole, type Tx } from '@autodev/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';

const { orgMembers, teamMembers, users } = schema;

async function activeOwnerCount(tx: Tx, orgId: string) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, 'owner'), eq(orgMembers.status, 'active')));
  return row?.n ?? 0;
}

/**
 * Admins can manage developers and viewers. Only owners can grant, change or remove the
 * owner role, and an org always keeps at least one active owner.
 */
async function loadTarget(tx: Tx, orgId: string, userId: string) {
  const [target] = await tx
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId), eq(orgMembers.status, 'active')));
  if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found' });
  return target;
}

function assertCanManage(actorRole: OrgRole, targetCurrent: OrgRole, targetNext: OrgRole | null) {
  const touchesOwner = targetCurrent === 'owner' || targetNext === 'owner';
  if (touchesOwner && actorRole !== 'owner') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only owners can change owners' });
  }
  if (targetCurrent === 'admin' && actorRole === 'admin' && targetNext !== 'admin') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only owners can demote or remove admins' });
  }
}

export const membersRouter = router({
  list: orgProcedure.query(({ ctx }) =>
    ctx.inOrg((tx) =>
      tx
        .select({
          userId: users.id,
          githubLogin: users.githubLogin,
          name: users.name,
          avatarUrl: users.avatarUrl,
          role: orgMembers.role,
          joinedAt: orgMembers.joinedAt,
        })
        .from(orgMembers)
        .innerJoin(users, eq(users.id, orgMembers.userId))
        .where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.status, 'active')))
        .orderBy(asc(users.githubLogin)),
    ),
  ),

  setRole: adminProcedure
    .input(z.object({ userId: z.string().uuid(), role: z.enum(ORG_ROLES) }))
    .mutation(({ ctx, input }) =>
      ctx.inOrg(async (tx) => {
        const target = await loadTarget(tx, ctx.orgId, input.userId);
        if (target.role === input.role) return { ok: true };
        assertCanManage(ctx.role, target.role, input.role);
        if (target.role === 'owner' && (await activeOwnerCount(tx, ctx.orgId)) <= 1) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'An org needs at least one owner' });
        }
        await tx
          .update(orgMembers)
          .set({ role: input.role })
          .where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.userId, input.userId)));
        await ctx.audit(tx, {
          action: 'member.role_changed',
          targetType: 'user',
          targetId: input.userId,
          metadata: { from: target.role, to: input.role },
        });
        return { ok: true };
      }),
    ),

  remove: adminProcedure.input(z.object({ userId: z.string().uuid() })).mutation(({ ctx, input }) =>
    ctx.inOrg(async (tx) => {
      const target = await loadTarget(tx, ctx.orgId, input.userId);
      assertCanManage(ctx.role, target.role, null);
      if (target.role === 'owner' && (await activeOwnerCount(tx, ctx.orgId)) <= 1) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'An org needs at least one owner' });
      }
      await tx
        .update(orgMembers)
        .set({ status: 'removed' })
        .where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.userId, input.userId)));
      await tx
        .delete(teamMembers)
        .where(and(eq(teamMembers.orgId, ctx.orgId), eq(teamMembers.userId, input.userId)));
      await ctx.audit(tx, { action: 'member.removed', targetType: 'user', targetId: input.userId, metadata: { role: target.role } });
      return { ok: true };
    }),
  ),
});
