import { codeIndexRepoJobId } from '@autodev/config';
import { and, eq, schema } from '@autodev/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { codeIndexEnabled } from '../../services/code-index';
import { adminProcedure, orgProcedure, roleAtLeast, router } from '../trpc';
import { readableRepo } from './chat';

const { codeIndexState, orgs } = schema;

/** The code index (B-2): where a repo's index stands, and a way for admins to rebuild it. */
export const codeIndexRouter = router({
  status: orgProcedure.input(z.object({ repoId: z.string().uuid() })).query(async ({ ctx, input }) =>
    ctx.inOrg(async (tx) => {
      await readableRepo(tx, ctx.orgId, ctx.userId, input.repoId);
      const [org] = await tx.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, ctx.orgId));
      const [state] = await tx
        .select({
          status: codeIndexState.status,
          commitSha: codeIndexState.commitSha,
          files: codeIndexState.files,
          chunks: codeIndexState.chunks,
          skippedFiles: codeIndexState.skippedFiles,
          error: codeIndexState.error,
          finishedAt: codeIndexState.finishedAt,
        })
        .from(codeIndexState)
        .where(and(eq(codeIndexState.orgId, ctx.orgId), eq(codeIndexState.repoId, input.repoId)));
      return { enabled: codeIndexEnabled(org?.settings), canReindex: roleAtLeast(ctx.role, 'admin'), state: state ?? null };
    }),
  ),

  reindex: adminProcedure.input(z.object({ repoId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    await ctx.inOrg(async (tx) => {
      await readableRepo(tx, ctx.orgId, ctx.userId, input.repoId);
      const [org] = await tx.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, ctx.orgId));
      if (!codeIndexEnabled(org?.settings)) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Turn on the code index in Settings first' });
      await ctx.audit(tx, { action: 'code_index.reindex_requested', targetType: 'repo', targetId: input.repoId });
    });
    await ctx.deps.queues.codeIndex.add('repo', { kind: 'repo', orgId: ctx.orgId, repoId: input.repoId }, { jobId: codeIndexRepoJobId(input.repoId) });
    return { queued: true };
  }),
});
