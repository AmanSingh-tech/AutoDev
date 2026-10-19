import { and, eq, MEMORY_SECTIONS, schema } from '@autodev/db';
import { MEMORY_TITLES } from '@autodev/agent';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { orgProcedure, roleAtLeast, router } from '../trpc';
import { readableRepo } from './chat';

const { repoAgentMemory, users } = schema;

export const MAX_MEMORY_CHARS = 8000;

/**
 * The Repo Agent's memory: one note per section per repo, read by repo chat and the Repo Agent.
 * Everyone with access to the repo reads it; people who can push to it, and org admins, edit it.
 */
export const repoAgentRouter = router({
  memory: router({
    get: orgProcedure.input(z.object({ repoId: z.string().uuid() })).query(async ({ ctx, input }) => {
      const rows = await ctx.inOrg(async (tx) => {
        await readableRepo(tx, ctx.orgId, ctx.userId, input.repoId);
        return tx
          .select({ section: repoAgentMemory.section, contentMd: repoAgentMemory.contentMd, updatedAt: repoAgentMemory.updatedAt, updatedBy: users.githubLogin })
          .from(repoAgentMemory)
          .leftJoin(users, eq(users.id, repoAgentMemory.updatedBy))
          .where(and(eq(repoAgentMemory.orgId, ctx.orgId), eq(repoAgentMemory.repoId, input.repoId)));
      });
      const canEdit = await canEditMemory(ctx, input.repoId);
      return {
        canEdit,
        sections: MEMORY_SECTIONS.map((section) => {
          const row = rows.find((r) => r.section === section);
          return { section, title: MEMORY_TITLES[section], contentMd: row?.contentMd ?? '', updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null };
        }),
      };
    }),

    update: orgProcedure
      .input(z.object({ repoId: z.string().uuid(), section: z.enum(MEMORY_SECTIONS), contentMd: z.string().max(MAX_MEMORY_CHARS) }))
      .mutation(async ({ ctx, input }) => {
        if (!(await canEditMemory(ctx, input.repoId)))
          throw new TRPCError({ code: 'FORBIDDEN', message: 'You need push access to this repository, or to be an admin, to edit its memory' });
        return ctx.inOrg(async (tx) => {
          await readableRepo(tx, ctx.orgId, ctx.userId, input.repoId);
          const values = { contentMd: input.contentMd, updatedBy: ctx.userId, updatedAt: new Date() };
          const [row] = await tx
            .insert(repoAgentMemory)
            .values({ orgId: ctx.orgId, repoId: input.repoId, section: input.section, ...values })
            .onConflictDoUpdate({ target: [repoAgentMemory.repoId, repoAgentMemory.section], set: values })
            .returning();
          await ctx.audit(tx, {
            action: 'repo_agent_memory.updated',
            targetType: 'repo',
            targetId: input.repoId,
            metadata: { section: input.section, chars: input.contentMd.length },
          });
          return { section: row!.section, updatedAt: row!.updatedAt };
        });
      }),
  }),
});

async function canEditMemory(ctx: { deps: { repoAccess: { listWritable: (o: string, u: string) => Promise<{ id: string }[]> } }; orgId: string; userId: string; role: Parameters<typeof roleAtLeast>[0] }, repoId: string) {
  if (roleAtLeast(ctx.role, 'admin')) return true;
  const writable = await ctx.deps.repoAccess.listWritable(ctx.orgId, ctx.userId);
  return writable.some((r) => r.id === repoId);
}
