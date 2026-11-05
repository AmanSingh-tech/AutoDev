import { insightsJobId } from '@autodev/config';
import { and, count, eq, schema, sql } from '@autodev/db';
import { createDemoOrg, isDemoOrg, mergeDemoPr } from '@autodev/demo';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { authedProcedure, orgProcedure, roleAtLeast, router } from '../trpc';

const { orgMembers, orgs, tasks, users } = schema;

/** Each person can have a few demo orgs at once; "Try the demo" reuses the newest. */
const MAX_DEMO_ORGS = 3;

/**
 * Demo mode: a sample org with a simulated agent, for trying AutoDev (or showing it to a
 * customer) without GitHub repos, an AI key or a builder. Clearly marked as a demo everywhere.
 */
export const demoRouter = router({
  /** Opens the person's demo org, creating it the first time (or a fresh one with `fresh`). */
  start: authedProcedure.input(z.object({ fresh: z.boolean().optional() }).optional()).mutation(async ({ ctx, input }) => {
    const mine = await ctx.deps.sys
      .select({ id: orgs.id, slug: orgs.slug })
      .from(orgMembers)
      .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
      .where(and(eq(orgMembers.userId, ctx.userId), eq(orgMembers.role, 'owner'), eq(orgMembers.status, 'active'), sql`coalesce((${orgs.settings} ->> 'demo')::boolean, false)`))
      .orderBy(sql`${orgs.createdAt} desc`);
    if (mine[0] && !input?.fresh) return { slug: mine[0].slug, created: false };
    if (mine.length >= MAX_DEMO_ORGS) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: `You already have ${MAX_DEMO_ORGS} demo organizations. Open one from your organizations.` });
    const [user] = await ctx.deps.sys.select({ login: users.githubLogin }).from(users).where(eq(users.id, ctx.userId));
    const { orgId, slug } = await createDemoOrg({ sys: ctx.deps.sys, kms: ctx.deps.kms, blobs: ctx.deps.blobs, webUrl: ctx.deps.env.WEB_URL }, { id: ctx.userId, login: user!.login });
    // Insights for the sample month, computed by the worker.
    await ctx.deps.queues.insights.add('insights', { orgId }, { jobId: insightsJobId(orgId) });
    return { slug, created: true };
  }),

  /** What GitHub's merge webhook does in a real org: the PR merges and the task resolves. */
  merge: orgProcedure.input(z.object({ key: z.string() })).mutation(async ({ ctx, input }) => {
    if (!(await isDemoOrg(ctx.deps.sys, ctx.orgId))) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only demo pull requests can be merged here; merge on GitHub' });
    const [t] = await ctx.inOrg((tx) => tx.select({ id: tasks.id, ownerId: tasks.ownerId }).from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.key, input.key))));
    if (!t) throw new TRPCError({ code: 'NOT_FOUND' });
    if (t.ownerId !== ctx.userId && !roleAtLeast(ctx.role, 'admin')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task owner or an admin can merge' });
    const done = await mergeDemoPr(ctx.deps.sys, t.id, ctx.userId);
    if (!done) throw new TRPCError({ code: 'BAD_REQUEST', message: 'There is no open pull request to merge' });
    return { ok: true };
  }),

  /**
   * A fresh copy of the demo, e.g. before showing it to someone: you leave this demo org and get a
   * new one. (Nothing is deleted: the audit log keeps what happened in the old one.)
   */
  reset: orgProcedure.mutation(async ({ ctx }) => {
    if (!(await isDemoOrg(ctx.deps.sys, ctx.orgId))) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only demo organizations can be reset' });
    if (ctx.role !== 'owner') throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the demo’s owner can reset it' });
    await ctx.deps.sys.update(orgMembers).set({ status: 'removed' }).where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.userId, ctx.userId)));
    const [user] = await ctx.deps.sys.select({ login: users.githubLogin }).from(users).where(eq(users.id, ctx.userId));
    const { orgId, slug } = await createDemoOrg({ sys: ctx.deps.sys, kms: ctx.deps.kms, blobs: ctx.deps.blobs, webUrl: ctx.deps.env.WEB_URL }, { id: ctx.userId, login: user!.login });
    await ctx.deps.queues.insights.add('insights', { orgId }, { jobId: insightsJobId(orgId) });
    return { slug };
  }),

  /** How many demo orgs the person has, for the "Try the demo" buttons. */
  mine: authedProcedure.query(async ({ ctx }) => {
    const [r] = await ctx.deps.sys
      .select({ n: count() })
      .from(orgMembers)
      .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
      .where(and(eq(orgMembers.userId, ctx.userId), eq(orgMembers.status, 'active'), sql`coalesce((${orgs.settings} ->> 'demo')::boolean, false)`));
    return { count: Number(r?.n ?? 0) };
  }),
});
