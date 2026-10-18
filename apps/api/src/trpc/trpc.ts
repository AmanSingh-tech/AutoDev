import { and, eq, schema, withOrg, type OrgRole, type Tx } from '@autodev/db';
import { GitHubReauthRequired } from '@autodev/github';
import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { ZodError } from 'zod';
import type { Deps } from '../deps';
import { audit, type AuditEntry } from '../services/audit';

export interface Context {
  deps: Deps;
  userId: string | null;
  /** From the x-org-id header. Membership is checked in orgProcedure, never trusted as-is. */
  orgId: string | null;
  ip: string | null;
  userAgent: string | null;
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zod: error.cause instanceof ZodError ? error.cause.flatten() : null,
        reauth: error.cause instanceof GitHubReauthRequired,
      },
    };
  },
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

/** Maps domain errors to tRPC codes so the web app can react (e.g. send the user to re-login). */
const errorMapping = t.middleware(async ({ next }) => {
  const res = await next();
  if (!res.ok && res.error.cause instanceof GitHubReauthRequired) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'GITHUB_REAUTH_REQUIRED', cause: res.error.cause });
  }
  return res;
});

export const publicProcedure = t.procedure.use(errorMapping);

export const authedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.userId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});

const RANK: Record<OrgRole, number> = { viewer: 0, developer: 1, admin: 2, owner: 3 };
export const roleAtLeast = (role: OrgRole, min: OrgRole) => RANK[role] >= RANK[min];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Requires an active membership in ctx.orgId and exposes an RLS-scoped transaction helper. */
export const orgProcedure = authedProcedure.use(async ({ ctx, next }) => {
  if (!ctx.orgId || !UUID.test(ctx.orgId)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'x-org-id header required' });
  const { orgId, userId, deps } = ctx;
  const [member] = await withOrg(deps.app, orgId, userId, (tx) =>
    tx
      .select({ role: schema.orgMembers.role })
      .from(schema.orgMembers)
      .where(
        and(
          eq(schema.orgMembers.orgId, orgId),
          eq(schema.orgMembers.userId, userId),
          eq(schema.orgMembers.status, 'active'),
        ),
      ),
  );
  // FORBIDDEN instead of NOT_FOUND, but the message doesn't say whether the org exists.
  if (!member) throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this org' });

  const inOrg = <T>(fn: (tx: Tx) => Promise<T>) => withOrg(deps.app, orgId, userId, fn);
  const auditIn = (tx: Tx, e: Omit<AuditEntry, 'orgId' | 'actorUserId' | 'ip' | 'userAgent'>) =>
    audit(tx, { ...e, orgId, actorUserId: userId, ip: ctx.ip, userAgent: ctx.userAgent });

  return next({ ctx: { ...ctx, orgId, role: member.role, inOrg, audit: auditIn } });
});

export const requireRole = (min: OrgRole) =>
  orgProcedure.use(({ ctx, next }) => {
    if (!roleAtLeast(ctx.role, min)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: `Requires ${min} role` });
    }
    return next();
  });

export const adminProcedure = requireRole('admin');
