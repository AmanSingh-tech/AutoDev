import { and, asc, eq, schema } from '@autodev/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';

const { orgMembers, teamMembers, teams, users } = schema;

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

export const teamsRouter = router({
  list: orgProcedure.query(({ ctx }) =>
    ctx.inOrg(async (tx) => {
      const rows = await tx.select().from(teams).where(eq(teams.orgId, ctx.orgId)).orderBy(asc(teams.name));
      const members = await tx
        .select({ teamId: teamMembers.teamId, userId: users.id, githubLogin: users.githubLogin, avatarUrl: users.avatarUrl })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(eq(teamMembers.orgId, ctx.orgId));
      return rows.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        members: members.filter((m) => m.teamId === t.id).map(({ teamId: _, ...m }) => m),
      }));
    }),
  ),

  create: adminProcedure.input(z.object({ name: z.string().trim().min(1).max(64) })).mutation(({ ctx, input }) =>
    ctx.inOrg(async (tx) => {
      const slug = slugify(input.name);
      if (!slug) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Team name needs letters or digits' });
      const [team] = await tx
        .insert(teams)
        .values({ orgId: ctx.orgId, name: input.name, slug })
        .onConflictDoNothing()
        .returning();
      if (!team) throw new TRPCError({ code: 'CONFLICT', message: 'A team with that name already exists' });
      await ctx.audit(tx, { action: 'team.created', targetType: 'team', targetId: team.id, metadata: { name: team.name } });
      return team;
    }),
  ),

  delete: adminProcedure.input(z.object({ teamId: z.string().uuid() })).mutation(({ ctx, input }) =>
    ctx.inOrg(async (tx) => {
      const [gone] = await tx
        .delete(teams)
        .where(and(eq(teams.orgId, ctx.orgId), eq(teams.id, input.teamId)))
        .returning();
      if (!gone) throw new TRPCError({ code: 'NOT_FOUND' });
      await ctx.audit(tx, { action: 'team.deleted', targetType: 'team', targetId: gone.id, metadata: { name: gone.name } });
      return { ok: true };
    }),
  ),

  addMember: adminProcedure
    .input(z.object({ teamId: z.string().uuid(), userId: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      ctx.inOrg(async (tx) => {
        const [team] = await tx.select().from(teams).where(and(eq(teams.orgId, ctx.orgId), eq(teams.id, input.teamId)));
        if (!team) throw new TRPCError({ code: 'NOT_FOUND', message: 'Team not found' });
        const [member] = await tx
          .select()
          .from(orgMembers)
          .where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.userId, input.userId), eq(orgMembers.status, 'active')));
        if (!member) throw new TRPCError({ code: 'BAD_REQUEST', message: 'User is not an active member of this org' });
        await tx.insert(teamMembers).values({ teamId: team.id, userId: input.userId, orgId: ctx.orgId }).onConflictDoNothing();
        await ctx.audit(tx, { action: 'team.member_added', targetType: 'team', targetId: team.id, metadata: { userId: input.userId } });
        return { ok: true };
      }),
    ),

  removeMember: adminProcedure
    .input(z.object({ teamId: z.string().uuid(), userId: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      ctx.inOrg(async (tx) => {
        await tx
          .delete(teamMembers)
          .where(
            and(eq(teamMembers.orgId, ctx.orgId), eq(teamMembers.teamId, input.teamId), eq(teamMembers.userId, input.userId)),
          );
        await ctx.audit(tx, { action: 'team.member_removed', targetType: 'team', targetId: input.teamId, metadata: { userId: input.userId } });
        return { ok: true };
      }),
    ),
});
