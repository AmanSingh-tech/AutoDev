import { and, asc, eq, schema, withUser } from '@autodev/db';
import { authedProcedure, router } from '../trpc';

const { orgMembers, orgs, users } = schema;

export const meRouter = router({
  /** The signed-in user and the orgs they're active in (feeds the org switcher). */
  get: authedProcedure.query(({ ctx }) =>
    withUser(ctx.deps.app, ctx.userId, async (tx) => {
      const [user] = await tx
        .select({ id: users.id, githubLogin: users.githubLogin, name: users.name, avatarUrl: users.avatarUrl })
        .from(users)
        .where(eq(users.id, ctx.userId));
      const memberships = await tx
        .select({ orgId: orgs.id, slug: orgs.slug, name: orgs.name, role: orgMembers.role })
        .from(orgMembers)
        .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
        .where(and(eq(orgMembers.userId, ctx.userId), eq(orgMembers.status, 'active')))
        .orderBy(asc(orgs.name));
      return { user: user ?? null, orgs: memberships };
    }),
  ),
});
