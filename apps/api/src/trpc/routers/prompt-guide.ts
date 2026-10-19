import { and, eq, isNull, schema } from '@autodev/db';
import { PromptGuideError, reviewTaskDraft } from '@autodev/agent';
import { LlmBlocked } from '@autodev/llm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { orgProcedure, router } from '../trpc';

const { repos } = schema;

/**
 * Prompt guide: reviews a task draft before it is started. Stores nothing; the answer is shown
 * in the form and applied only if the author chooses to. Costs come from the org's key and budgets.
 */
export const promptGuideRouter = router({
  review: orgProcedure
    .input(
      z.object({
        repoId: z.string().uuid(),
        title: z.string().max(200),
        descriptionMd: z.string().max(20_000),
        acceptanceCriteriaMd: z.string().max(10_000),
        extraContext: z.string().max(5_000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Same bar as creating a task: the caller must be able to push to this repo.
      const writable = await ctx.deps.repoAccess.listWritable(ctx.orgId, ctx.userId);
      if (!writable.some((r) => r.id === input.repoId)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You need push access to this repository on GitHub',
        });
      }
      const [repo] = await ctx.inOrg((tx) =>
        tx
          .select({ fullName: repos.fullName })
          .from(repos)
          .where(
            and(eq(repos.id, input.repoId), eq(repos.orgId, ctx.orgId), isNull(repos.deletedAt)),
          ),
      );
      if (!repo) throw new TRPCError({ code: 'NOT_FOUND', message: 'Repository not found' });

      try {
        return await reviewTaskDraft(
          ctx.deps.gateway,
          { orgId: ctx.orgId, userId: ctx.userId, repoId: input.repoId },
          {
            repoFullName: repo.fullName,
            title: input.title,
            descriptionMd: input.descriptionMd,
            acceptanceCriteriaMd: input.acceptanceCriteriaMd,
            extraContext: input.extraContext,
          },
        );
      } catch (e) {
        if (e instanceof LlmBlocked)
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message, cause: e });
        if (e instanceof PromptGuideError)
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: e.message, cause: e });
        throw e;
      }
    }),
});
