import { randomBytes } from 'node:crypto';
import { presenceKey } from '@autodev/agent';
import { and, asc, eq, inArray, isNull, or, schema, sql } from '@autodev/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { hashBuilderToken } from '../../services/builder-tokens';
import { pairDeviceKey, pairUserKey, PAIRING_TTL_SECONDS, type PairingState } from '../../routes/builder';
import { adminProcedure, orgProcedure, requireRole, roleAtLeast, router } from '../trpc';

const { builderJobs, builderRepoBindings, builders, orgs, repos, users } = schema;

/** Everything but token_hash, which the app role can't read. */
const builderCols = { id: builders.id, name: builders.name, kind: builders.kind, ownerUserId: builders.ownerUserId, orgId: builders.orgId };

export const buildersRouter = router({
  /** My builders and the org's team builders, with live presence and repo bindings. */
  list: orgProcedure.query(async ({ ctx }) => {
    const rows = await ctx.inOrg((tx) =>
      tx
        .select({ id: builders.id, name: builders.name, kind: builders.kind, allowShared: builders.allowShared, ownerUserId: builders.ownerUserId, ownerLogin: users.githubLogin, os: builders.os, arch: builders.arch, cliVersion: builders.cliVersion, dockerAvailable: builders.dockerAvailable, lastSeenAt: builders.lastSeenAt, createdAt: builders.createdAt })
        .from(builders)
        .innerJoin(users, eq(users.id, builders.ownerUserId))
        .where(and(eq(builders.orgId, ctx.orgId), isNull(builders.revokedAt), or(eq(builders.ownerUserId, ctx.userId), eq(builders.kind, 'team'))))
        .orderBy(asc(builders.name)),
    );
    const ids = rows.map((r) => r.id);
    const bindings = ids.length
      ? await ctx.inOrg((tx) =>
          tx
            .select({ builderId: builderRepoBindings.builderId, repoId: repos.id, fullName: repos.fullName, localPath: builderRepoBindings.localPath, confirmed: builderRepoBindings.firstRunConfirmedAt })
            .from(builderRepoBindings)
            .innerJoin(repos, eq(repos.id, builderRepoBindings.repoId))
            .where(inArray(builderRepoBindings.builderId, ids)),
        )
      : [];
    const running = ids.length
      ? await ctx.inOrg((tx) => tx.select({ builderId: builderJobs.builderId, jobId: builderJobs.id, taskId: builderJobs.taskId }).from(builderJobs).where(and(inArray(builderJobs.builderId, ids), inArray(builderJobs.status, ['offered', 'running']))))
      : [];
    return Promise.all(
      rows.map(async (b) => ({
        ...b,
        online: (await ctx.deps.cache.get(presenceKey(b.id))) !== null,
        mine: b.ownerUserId === ctx.userId,
        bindings: bindings.filter((x) => x.builderId === b.id),
        runningJob: running.find((r) => r.builderId === b.id) ?? null,
      })),
    );
  }),

  /** The dashboard half of `autodev login`: approve the code the CLI shows. */
  approvePairing: requireRole('developer')
    .input(z.object({ userCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/), name: z.string().trim().min(1).max(64).optional(), kind: z.enum(['personal', 'team']).default('personal') }))
    .mutation(async ({ ctx, input }) => {
      if (input.kind === 'team' && !roleAtLeast(ctx.role, 'admin')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only admins can add team builders' });
      const deviceHash = await ctx.deps.cache.get(pairUserKey(input.userCode));
      const raw = deviceHash ? await ctx.deps.cache.get(`pair:device:${deviceHash}`) : null;
      if (!deviceHash || !raw) throw new TRPCError({ code: 'NOT_FOUND', message: 'That code is unknown or expired. Run `autodev login` again.' });
      const state = JSON.parse(raw) as PairingState;
      if (state.status !== 'pending') throw new TRPCError({ code: 'CONFLICT', message: 'That code was already used' });

      const token = `adb_${randomBytes(32).toString('base64url')}`;
      const [b] = await ctx.deps.sys
        .insert(builders)
        .values({ orgId: ctx.orgId, ownerUserId: ctx.userId, name: input.name ?? state.name, kind: input.kind, tokenHash: hashBuilderToken(token) })
        .returning({ id: builders.id, name: builders.name });
      const [org] = await ctx.inOrg((tx) => tx.select({ slug: orgs.slug }).from(orgs).where(eq(orgs.id, ctx.orgId)));
      const approved: PairingState = { ...state, status: 'approved', token, builderId: b!.id, orgSlug: org!.slug };
      await ctx.deps.cache.set(`pair:device:${deviceHash}`, JSON.stringify(approved), PAIRING_TTL_SECONDS);
      await ctx.deps.cache.del(pairUserKey(input.userCode));
      await ctx.inOrg((tx) => ctx.audit(tx, { action: 'builder.paired', targetType: 'builder', targetId: b!.id, metadata: { name: b!.name, kind: input.kind } }));
      return { id: b!.id, name: b!.name };
    }),

  revoke: requireRole('developer')
    .input(z.object({ builderId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [b] = await ctx.inOrg((tx) => tx.select(builderCols).from(builders).where(and(eq(builders.orgId, ctx.orgId), eq(builders.id, input.builderId))));
      if (!b) throw new TRPCError({ code: 'NOT_FOUND' });
      if (b.ownerUserId !== ctx.userId && !roleAtLeast(ctx.role, 'admin')) throw new TRPCError({ code: 'FORBIDDEN' });
      await ctx.deps.sys.update(builders).set({ revokedAt: new Date() }).where(eq(builders.id, b.id));
      await ctx.deps.builderJobs.disconnected(b.id);
      await ctx.inOrg((tx) => ctx.audit(tx, { action: 'builder.revoked', targetType: 'builder', targetId: b.id, metadata: { name: b.name } }));
      return { ok: true };
    }),

  setShared: adminProcedure.input(z.object({ builderId: z.string().uuid(), allowShared: z.boolean() })).mutation(async ({ ctx, input }) => {
    const [b] = await ctx.deps.sys
      .update(builders)
      .set({ allowShared: input.allowShared })
      .where(and(eq(builders.orgId, ctx.orgId), eq(builders.id, input.builderId), eq(builders.kind, 'team')))
      .returning(builderCols);
    if (!b) throw new TRPCError({ code: 'NOT_FOUND', message: 'Team builder not found' });
    await ctx.inOrg((tx) => ctx.audit(tx, { action: 'builder.sharing_changed', targetType: 'builder', targetId: b.id, metadata: input }));
    return { ok: true };
  }),

  /**
   * "The first run per repo needs confirmation": the builder's owner sees the exact commands from
   * the base branch's .autodev.yml and allows the builder to run them for that repo.
   */
  pendingConfirmations: orgProcedure.query(({ ctx }) =>
    ctx.inOrg(async (tx) => {
      const mine = await tx.select({ id: builders.id, name: builders.name }).from(builders).where(and(eq(builders.orgId, ctx.orgId), eq(builders.ownerUserId, ctx.userId), isNull(builders.revokedAt)));
      if (!mine.length) return [];
      const queued = await tx
        .select({ repoId: builderJobs.repoId, fullName: repos.fullName, config: builderJobs.configSnapshot })
        .from(builderJobs)
        .innerJoin(repos, eq(repos.id, builderJobs.repoId))
        .where(and(eq(builderJobs.orgId, ctx.orgId), eq(builderJobs.status, 'queued'), sql`${builderJobs.consent} <> 'denied'`))
        .orderBy(asc(builderJobs.queuedAt));
      const bound = await tx.select().from(builderRepoBindings).where(inArray(builderRepoBindings.builderId, mine.map((b) => b.id)));
      const out: { builderId: string; builderName: string; repoId: string; repoFullName: string; config: unknown }[] = [];
      for (const b of mine) {
        for (const q of queued) {
          const binding = bound.find((x) => x.builderId === b.id && x.repoId === q.repoId);
          if (binding?.firstRunConfirmedAt || out.some((o) => o.builderId === b.id && o.repoId === q.repoId)) continue;
          out.push({ builderId: b.id, builderName: b.name, repoId: q.repoId, repoFullName: q.fullName, config: q.config });
        }
      }
      return out;
    }),
  ),

  confirmRepo: requireRole('developer')
    .input(z.object({ builderId: z.string().uuid(), repoId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [b] = await ctx.inOrg((tx) => tx.select(builderCols).from(builders).where(and(eq(builders.orgId, ctx.orgId), eq(builders.id, input.builderId), eq(builders.ownerUserId, ctx.userId))));
      if (!b) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the builder’s owner can confirm runs on it' });
      const [repo] = await ctx.inOrg((tx) => tx.select({ id: repos.id }).from(repos).where(and(eq(repos.orgId, ctx.orgId), eq(repos.id, input.repoId))));
      if (!repo) throw new TRPCError({ code: 'NOT_FOUND' });
      await ctx.deps.sys
        .insert(builderRepoBindings)
        .values({ builderId: b.id, repoId: repo.id, orgId: ctx.orgId, firstRunConfirmedAt: new Date(), confirmedBy: ctx.userId })
        .onConflictDoUpdate({ target: [builderRepoBindings.builderId, builderRepoBindings.repoId], set: { firstRunConfirmedAt: new Date(), confirmedBy: ctx.userId } });
      await ctx.inOrg((tx) => ctx.audit(tx, { action: 'builder.repo_confirmed', targetType: 'builder', targetId: b.id, metadata: { repoId: repo.id } }));
      await ctx.deps.builderJobs.dispatchFor(b.id);
      return { ok: true };
    }),
});
