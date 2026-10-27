import { and, count, eq, schema } from '@autodev/db';
import { ssoCheck, WorkosError } from '@autodev/sso';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';

const { directoryUsers, orgs, orgSso, ssoIdentities } = schema;

/**
 * Single sign-on and directory sync settings (B-7). The customer's IT admin connects their IdP and
 * directory in WorkOS's setup portal; AutoDev only stores the WorkOS ids and the "required" switch.
 */
export const ssoRouter = router({
  /** For the Security page (admins) and for members checking their own link. */
  get: orgProcedure.query(async ({ ctx }) => {
    const enabled = !!ctx.deps.sso.workos;
    const [cfg] = await ctx.deps.sys.select().from(orgSso).where(eq(orgSso.orgId, ctx.orgId));
    const [mine] = await ctx.deps.sys
      .select({ email: ssoIdentities.email, lastLoginAt: ssoIdentities.lastLoginAt })
      .from(ssoIdentities)
      .where(and(eq(ssoIdentities.orgId, ctx.orgId), eq(ssoIdentities.userId, ctx.userId)));
    const [linked] = await ctx.deps.sys.select({ n: count() }).from(ssoIdentities).where(eq(ssoIdentities.orgId, ctx.orgId));
    const [directory] = await ctx.deps.sys.select({ n: count() }).from(directoryUsers).where(and(eq(directoryUsers.orgId, ctx.orgId), eq(directoryUsers.state, 'active')));
    return {
      enabled,
      configured: !!cfg,
      ssoRequired: cfg?.ssoRequired ?? false,
      sessionHours: cfg?.sessionHours ?? 24,
      directoryConnected: !!cfg?.workosDirectoryId,
      linkedMembers: Number(linked?.n ?? 0),
      directoryUsers: Number(directory?.n ?? 0),
      mine: mine ?? null,
    };
  }),

  /** Creates the org's WorkOS organization (once) and returns a setup-portal link for SSO or the directory. */
  portalLink: adminProcedure.input(z.object({ intent: z.enum(['sso', 'dsync', 'domain_verification']) })).mutation(async ({ ctx, input }) => {
    const workos = ctx.deps.sso.workos;
    if (!workos) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Single sign-on isn’t set up on this server' });
    try {
      let [cfg] = await ctx.deps.sys.select().from(orgSso).where(eq(orgSso.orgId, ctx.orgId));
      if (!cfg) {
        const [org] = await ctx.deps.sys.select({ name: orgs.name, slug: orgs.slug }).from(orgs).where(eq(orgs.id, ctx.orgId));
        const created = await workos.createOrganization(org!.name, ctx.orgId);
        await ctx.inOrg(async (tx) => {
          await tx.insert(orgSso).values({ orgId: ctx.orgId, workosOrganizationId: created.id }).onConflictDoNothing();
          await ctx.audit(tx, { action: 'sso.organization_created', targetType: 'org', targetId: ctx.orgId, metadata: { workosOrganizationId: created.id } });
        });
        [cfg] = await ctx.deps.sys.select().from(orgSso).where(eq(orgSso.orgId, ctx.orgId));
      }
      const [org] = await ctx.deps.sys.select({ slug: orgs.slug }).from(orgs).where(eq(orgs.id, ctx.orgId));
      const { link } = await workos.portalLink(cfg!.workosOrganizationId, input.intent, `${ctx.deps.env.WEB_URL}/o/${org!.slug}/settings/security`);
      return { link };
    } catch (e) {
      if (e instanceof WorkosError) throw new TRPCError({ code: 'BAD_GATEWAY', message: `WorkOS: ${e.message}` });
      throw e;
    }
  }),

  /** Turning "required" on needs the admin's own recent SSO sign-in (owners are exempt anyway). */
  update: adminProcedure.input(z.object({ ssoRequired: z.boolean(), sessionHours: z.number().int().min(1).max(720) })).mutation(async ({ ctx, input }) => {
    const [cfg] = await ctx.deps.sys.select().from(orgSso).where(eq(orgSso.orgId, ctx.orgId));
    if (!cfg) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Connect an identity provider first' });
    if (input.ssoRequired && ctx.role !== 'owner') {
      const mine = await ssoCheck(ctx.deps.sys, ctx.orgId, ctx.userId, ctx.role);
      const [identity] = await ctx.deps.sys.select({ id: ssoIdentities.id }).from(ssoIdentities).where(and(eq(ssoIdentities.orgId, ctx.orgId), eq(ssoIdentities.userId, ctx.userId)));
      if (!identity || (mine.required && !mine.ok)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Sign in with SSO yourself first, so you aren’t locked out' });
    }
    await ctx.inOrg(async (tx) => {
      await tx.update(orgSso).set({ ...input, updatedAt: new Date() }).where(eq(orgSso.orgId, ctx.orgId));
      await ctx.audit(tx, { action: 'sso.settings_updated', targetType: 'org', targetId: ctx.orgId, metadata: input });
    });
    return { ok: true };
  }),
});
