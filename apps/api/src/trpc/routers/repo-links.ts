import { and, eq, or, schema, type Tx } from '@autodev/db';
import { alias } from '@autodev/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, orgProcedure, roleAtLeast, router } from '../trpc';
import { readableRepo } from './chat';

const { repoLinks, repos } = schema;

export const MAX_MAPPING_NOTES = 8000;

const notes = z.string().max(MAX_MAPPING_NOTES);

/** Links between repos for cross-repo sync (B-3). Everyone sees the links of repos they can access; admins change them. */
export const repoLinksRouter = router({
  list: orgProcedure.query(async ({ ctx }) => {
    // Links are shown by repo access (RLS), so make sure the caller's access is current.
    await ctx.deps.repoAccess.listWritable(ctx.orgId, ctx.userId);
    const source = alias(repos, 'source');
    const target = alias(repos, 'target');
    const rows = await ctx.inOrg((tx) =>
      tx
        .select({
          id: repoLinks.id,
          twoWay: repoLinks.twoWay,
          mappingNotesMd: repoLinks.mappingNotesMd,
          updatedAt: repoLinks.updatedAt,
          source: { id: source.id, fullName: source.fullName, name: source.name },
          target: { id: target.id, fullName: target.fullName, name: target.name },
        })
        .from(repoLinks)
        .innerJoin(source, eq(source.id, repoLinks.sourceRepoId))
        .innerJoin(target, eq(target.id, repoLinks.targetRepoId))
        .where(eq(repoLinks.orgId, ctx.orgId))
        .orderBy(source.fullName, target.fullName),
    );
    return { canEdit: roleAtLeast(ctx.role, 'admin'), links: rows };
  }),

  create: adminProcedure
    .input(z.object({ sourceRepoId: z.string().uuid(), targetRepoId: z.string().uuid(), twoWay: z.boolean().default(false), mappingNotesMd: notes.default('') }))
    .mutation(async ({ ctx, input }) => {
      if (input.sourceRepoId === input.targetRepoId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Pick two different repositories' });
      await ctx.deps.repoAccess.listWritable(ctx.orgId, ctx.userId);
      return ctx.inOrg(async (tx) => {
        const [source, target] = [await readableRepo(tx, ctx.orgId, ctx.userId, input.sourceRepoId), await readableRepo(tx, ctx.orgId, ctx.userId, input.targetRepoId)];
        const [existing] = await tx
          .select({ id: repoLinks.id })
          .from(repoLinks)
          .where(
            or(
              and(eq(repoLinks.sourceRepoId, input.sourceRepoId), eq(repoLinks.targetRepoId, input.targetRepoId)),
              and(eq(repoLinks.sourceRepoId, input.targetRepoId), eq(repoLinks.targetRepoId, input.sourceRepoId)),
            ),
          );
        if (existing) throw new TRPCError({ code: 'CONFLICT', message: 'These repositories are already linked. Edit that link instead.' });
        const [link] = await tx.insert(repoLinks).values({ orgId: ctx.orgId, ...input, createdBy: ctx.userId }).returning();
        await ctx.audit(tx, { action: 'repo_link.created', targetType: 'repo_link', targetId: link!.id, metadata: { source: source.fullName, target: target.fullName, twoWay: input.twoWay } });
        return link!;
      });
    }),

  update: adminProcedure
    .input(z.object({ id: z.string().uuid(), twoWay: z.boolean().optional(), mappingNotesMd: notes.optional() }))
    .mutation(({ ctx, input }) =>
      ctx.inOrg(async (tx) => {
        await loadLink(tx, ctx.orgId, input.id);
        const { id, ...set } = input;
        const [link] = await tx.update(repoLinks).set({ ...set, updatedAt: new Date() }).where(eq(repoLinks.id, id)).returning();
        await ctx.audit(tx, { action: 'repo_link.updated', targetType: 'repo_link', targetId: id, metadata: { twoWay: set.twoWay, notesChars: set.mappingNotesMd?.length } });
        return link!;
      }),
    ),

  delete: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(({ ctx, input }) =>
    ctx.inOrg(async (tx) => {
      await loadLink(tx, ctx.orgId, input.id);
      await tx.delete(repoLinks).where(eq(repoLinks.id, input.id));
      await ctx.audit(tx, { action: 'repo_link.deleted', targetType: 'repo_link', targetId: input.id });
      return { deleted: true };
    }),
  ),
});

/** RLS hides links of repos the caller can't access, so a hidden link reads as not found. */
async function loadLink(tx: Tx, orgId: string, id: string) {
  const [link] = await tx.select().from(repoLinks).where(and(eq(repoLinks.orgId, orgId), eq(repoLinks.id, id)));
  if (!link) throw new TRPCError({ code: 'NOT_FOUND', message: 'Link not found' });
  return link;
}

/** The repos a task in `repoId` can be applied to: targets of its links, and sources of two-way ones. */
export async function linkedTargets(tx: Tx, orgId: string, repoId: string) {
  const other = alias(repos, 'other');
  const rows = await tx
    .select({ linkId: repoLinks.id, mappingNotesMd: repoLinks.mappingNotesMd, repo: { id: other.id, name: other.name, fullName: other.fullName, deletedAt: other.deletedAt } })
    .from(repoLinks)
    .innerJoin(other, or(and(eq(repoLinks.sourceRepoId, repoId), eq(other.id, repoLinks.targetRepoId)), and(eq(repoLinks.twoWay, true), eq(repoLinks.targetRepoId, repoId), eq(other.id, repoLinks.sourceRepoId))))
    .where(eq(repoLinks.orgId, orgId));
  return rows.filter((r) => !r.repo.deletedAt).map(({ repo: { deletedAt: _d, ...repo }, ...r }) => ({ ...r, repo }));
}
