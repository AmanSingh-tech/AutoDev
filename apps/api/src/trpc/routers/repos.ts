import { and, eq, isNull, schema, TASK_MODES } from '@autodev/db';
import { installUrl, listBranches, userOctokit } from '@autodev/github';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, authedProcedure, orgProcedure, router } from '../trpc';

const { installations, repoPolicies, repos } = schema;

const BRANCH_CACHE_SECONDS = 5 * 60;

export const reposRouter = router({
  /** Only repos where the caller has push, maintain or admin on GitHub (15-minute cache). */
  list: orgProcedure.query(({ ctx }) => ctx.deps.repoAccess.listWritable(ctx.orgId, ctx.userId)),

  refresh: orgProcedure.mutation(({ ctx }) =>
    ctx.deps.repoAccess.listWritable(ctx.orgId, ctx.userId, { force: true }),
  ),

  /** Board header: any member can view a repo's board; canCreate says whether they can add tasks. */
  byName: orgProcedure.input(z.object({ name: z.string().min(1).max(100) })).query(async ({ ctx, input }) => {
    const [repo] = await ctx.inOrg((tx) =>
      tx
        .select({ id: repos.id, name: repos.name, fullName: repos.fullName, defaultBranch: repos.defaultBranch, lockedMode: repoPolicies.lockedMode, defaultMode: repoPolicies.defaultMode })
        .from(repos)
        .leftJoin(repoPolicies, eq(repoPolicies.repoId, repos.id))
        .where(and(eq(repos.orgId, ctx.orgId), eq(repos.name, input.name), isNull(repos.deletedAt))),
    );
    if (!repo) throw new TRPCError({ code: 'NOT_FOUND', message: 'Repository not found' });
    const writable = ctx.role === 'viewer' ? [] : await ctx.deps.repoAccess.listWritable(ctx.orgId, ctx.userId);
    // GitHub page of the repo, for links (citations, files). The web URL is configurable for GHES and tests.
    return { ...repo, canCreate: writable.some((r) => r.id === repo.id), htmlUrl: `${ctx.deps.cfg.webUrl}/${repo.fullName}` };
  }),

  /** Branch dropdown for "existing branch" tasks. Read with the caller's token, cached 5 minutes per repo. */
  branches: orgProcedure.input(z.object({ repoId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const [repo] = await ctx.inOrg((tx) => tx.select().from(repos).where(and(eq(repos.orgId, ctx.orgId), eq(repos.id, input.repoId))));
    if (!repo) throw new TRPCError({ code: 'NOT_FOUND' });
    const cacheKey = `branches:${repo.id}`;
    const hit = await ctx.deps.cache.get(cacheKey);
    if (hit) return JSON.parse(hit) as Awaited<ReturnType<typeof listBranches>>;
    const res = await ctx.deps.vault.withToken(ctx.userId, (token) => listBranches(userOctokit(ctx.deps.cfg, token), repo.owner, repo.name));
    await ctx.deps.cache.set(cacheKey, JSON.stringify(res), BRANCH_CACHE_SECONDS);
    return res;
  }),

  /** Admins can lock a repo to one mode (the task form then can't change it) or set its default. */
  setPolicy: adminProcedure
    .input(z.object({ repoId: z.string().uuid(), lockedMode: z.enum(TASK_MODES).nullable(), defaultMode: z.enum(TASK_MODES).nullable() }))
    .mutation(({ ctx, input }) =>
      ctx.inOrg(async (tx) => {
        const [repo] = await tx.select({ id: repos.id }).from(repos).where(and(eq(repos.orgId, ctx.orgId), eq(repos.id, input.repoId)));
        if (!repo) throw new TRPCError({ code: 'NOT_FOUND' });
        const values = { lockedMode: input.lockedMode, defaultMode: input.defaultMode, updatedBy: ctx.userId };
        await tx
          .insert(repoPolicies)
          .values({ repoId: repo.id, orgId: ctx.orgId, ...values })
          .onConflictDoUpdate({ target: repoPolicies.repoId, set: values });
        await ctx.audit(tx, { action: 'repo.policy_updated', targetType: 'repo', targetId: repo.id, metadata: input });
        return { ok: true };
      }),
    ),
});

export const installationsRouter = router({
  list: orgProcedure.query(({ ctx }) =>
    ctx.inOrg((tx) =>
      tx
        .select({
          id: installations.id,
          githubInstallationId: installations.githubInstallationId,
          accountLogin: installations.accountLogin,
          suspendedAt: installations.suspendedAt,
          createdAt: installations.createdAt,
        })
        .from(installations)
        .where(and(eq(installations.orgId, ctx.orgId), isNull(installations.deletedAt))),
    ),
  ),
});

export const githubRouter = router({
  /** Where to send someone who wants to install the App on a GitHub org (works before they have one). */
  installUrl: authedProcedure.query(({ ctx }) => ({ url: installUrl(ctx.deps.cfg) })),
});
