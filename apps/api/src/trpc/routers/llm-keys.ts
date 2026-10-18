import { and, desc, eq, inArray, schema } from '@autodev/db';
import { credentialMetaColumns, KeyRejected } from '@autodev/llm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { resumeBlockedTasks } from '../../services/agent-control';
import { orgProcedure, roleAtLeast, router } from '../trpc';

const { llmCredentials, orgs, teams, users } = schema;

const createInput = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('org') }),
  z.object({ scope: z.literal('team'), teamId: z.string().uuid() }),
  z.object({ scope: z.literal('user') }),
]).and(
  z.object({
    provider: z.enum(['anthropic']),
    label: z.string().trim().min(1).max(64),
    // Write-only: never echoed back, never logged.
    apiKey: z.string().trim().min(20).max(512),
  }),
);

export const llmKeysRouter = router({
  /** Admins see every key's metadata. Others see only their own personal keys. Never secrets. */
  list: orgProcedure.query(({ ctx }) =>
    ctx.inOrg((tx) =>
      tx
        .select({ ...credentialMetaColumns, teamName: teams.name, userLogin: users.githubLogin })
        .from(llmCredentials)
        .leftJoin(teams, eq(teams.id, llmCredentials.teamId))
        .leftJoin(users, eq(users.id, llmCredentials.userId))
        .where(
          and(
            eq(llmCredentials.orgId, ctx.orgId),
            inArray(llmCredentials.status, ['active', 'invalid']),
            roleAtLeast(ctx.role, 'admin') ? undefined : eq(llmCredentials.userId, ctx.userId),
          ),
        )
        .orderBy(desc(llmCredentials.createdAt)),
    ),
  ),

  /** Which key the caller's tasks would use right now. */
  effective: orgProcedure.query(async ({ ctx }) => {
    const policy = await ctx.deps.gateway.policy(ctx.orgId, 'agent');
    const cred = await ctx.deps.gateway.resolveCredential(ctx.orgId, ctx.userId, policy.provider);
    return cred ? { scope: cred.scope, last4: cred.last4 } : null;
  }),

  create: orgProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    if (input.scope === 'user') {
      if (ctx.role === 'viewer') throw new TRPCError({ code: 'FORBIDDEN', message: 'Viewers cannot add keys' });
      const [org] = await ctx.inOrg((tx) => tx.select({ allow: orgs.allowUserKeys }).from(orgs).where(eq(orgs.id, ctx.orgId)));
      if (!org?.allow) throw new TRPCError({ code: 'FORBIDDEN', message: 'Personal keys are turned off for this organization' });
    } else if (!roleAtLeast(ctx.role, 'admin')) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Only admins can add organization or team keys' });
    }
    if (input.scope === 'team') {
      const [team] = await ctx.inOrg((tx) => tx.select({ id: teams.id }).from(teams).where(and(eq(teams.orgId, ctx.orgId), eq(teams.id, input.teamId))));
      if (!team) throw new TRPCError({ code: 'NOT_FOUND', message: 'Team not found' });
    }
    try {
      const created = await ctx.deps.credentials.create({
        orgId: ctx.orgId,
        actorUserId: ctx.userId,
        scope: input.scope,
        teamId: input.scope === 'team' ? input.teamId : null,
        userId: input.scope === 'user' ? ctx.userId : null,
        provider: input.provider,
        label: input.label,
        apiKey: input.apiKey,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      // Tasks paused on a broken key pick up right away.
      await resumeBlockedTasks(ctx.deps, ctx.orgId, ctx.userId);
      return created;
    } catch (e) {
      if (e instanceof KeyRejected) throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
      throw e;
    }
  }),

  revoke: orgProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const [row] = await ctx.inOrg((tx) =>
      tx.select({ scope: llmCredentials.scope, userId: llmCredentials.userId }).from(llmCredentials).where(and(eq(llmCredentials.orgId, ctx.orgId), eq(llmCredentials.id, input.id))),
    );
    if (!row) throw new TRPCError({ code: 'NOT_FOUND' });
    const own = row.scope === 'user' && row.userId === ctx.userId;
    if (!own && !roleAtLeast(ctx.role, 'admin')) throw new TRPCError({ code: 'FORBIDDEN' });
    const res = await ctx.deps.credentials.revoke(ctx.orgId, ctx.userId, input.id, { ip: ctx.ip, userAgent: ctx.userAgent });
    if (!res) throw new TRPCError({ code: 'NOT_FOUND', message: 'Key is already revoked' });
    return { ok: true };
  }),
});
