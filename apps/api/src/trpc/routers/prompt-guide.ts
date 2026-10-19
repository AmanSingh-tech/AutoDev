import { and, asc, eq, isNull, schema } from '@autodev/db';
import { checkTaskDraft, PromptGuideError, rewriteTaskDraft, type TaskDraft } from '@autodev/agent';
import { LlmBlocked } from '@autodev/llm';
import { BUILT_IN_TEMPLATES, TEMPLATE_KINDS } from '@autodev/protocol';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { orgProcedure, requireRole, router } from '../trpc';

const { promptTemplates, repos } = schema;

const draftInput = z.object({
  repoId: z.string().uuid(),
  title: z.string().max(200),
  descriptionMd: z.string().max(20_000),
  acceptanceCriteriaMd: z.string().max(10_000),
  extraContext: z.string().max(10_000).optional(),
  scopePath: z.string().max(300).optional(),
});

const templateFields = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(TEMPLATE_KINDS),
  descriptionMd: z.string().max(20_000).default(''),
  acceptanceCriteriaMd: z.string().max(10_000).default(''),
});

type OrgCtx = Parameters<Parameters<typeof orgProcedure.query>[0]>[0]['ctx'];

/** Same bar as creating a task: the caller must be able to push to this repo. */
async function draftFor(ctx: OrgCtx, input: z.infer<typeof draftInput>): Promise<TaskDraft> {
  const writable = await ctx.deps.repoAccess.listWritable(ctx.orgId, ctx.userId);
  if (!writable.some((r) => r.id === input.repoId)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You need push access to this repository on GitHub' });
  }
  const [repo] = await ctx.inOrg((tx) =>
    tx
      .select({ fullName: repos.fullName })
      .from(repos)
      .where(and(eq(repos.id, input.repoId), eq(repos.orgId, ctx.orgId), isNull(repos.deletedAt))),
  );
  if (!repo) throw new TRPCError({ code: 'NOT_FOUND', message: 'Repository not found' });
  const { repoId: _repoId, ...draft } = input;
  return { repoFullName: repo.fullName, ...draft };
}

async function viaModel<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof LlmBlocked) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message, cause: e });
    if (e instanceof PromptGuideError) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: e.message, cause: e });
    throw e;
  }
}

/**
 * Prompt guide (B-1). The live score runs in the browser and on save (@autodev/protocol
 * prompt-check); these endpoints are the parts that call the model, plus the org's templates.
 * Model calls store nothing and cost the org's key and budgets under the `prompt_check` policy.
 */
export const promptGuideRouter = router({
  /** A deeper, model-based check: score, flags and suggestions. */
  check: orgProcedure.input(draftInput).mutation(async ({ ctx, input }) => {
    const draft = await draftFor(ctx, input);
    return viaModel(() => checkTaskDraft(ctx.deps.gateway, { orgId: ctx.orgId, userId: ctx.userId, repoId: input.repoId }, draft));
  }),

  /** One-click rewrite. The form applies it, and the author can undo. */
  rewrite: orgProcedure.input(draftInput).mutation(async ({ ctx, input }) => {
    const draft = await draftFor(ctx, input);
    return viaModel(() => rewriteTaskDraft(ctx.deps.gateway, { orgId: ctx.orgId, userId: ctx.userId, repoId: input.repoId }, draft));
  }),

  templates: router({
    /** Built-in templates first, then the org's own. */
    list: orgProcedure.query(async ({ ctx }) => {
      const own = await ctx.inOrg((tx) =>
        tx.select().from(promptTemplates).where(eq(promptTemplates.orgId, ctx.orgId)).orderBy(asc(promptTemplates.name)),
      );
      return [
        ...BUILT_IN_TEMPLATES.map((t) => ({ id: `builtin:${t.kind}`, builtIn: true as const, ...t })),
        ...own.map((t) => ({
          id: t.id,
          builtIn: false as const,
          kind: t.kind as (typeof TEMPLATE_KINDS)[number],
          name: t.name,
          descriptionMd: t.descriptionMd,
          acceptanceCriteriaMd: t.acceptanceCriteriaMd,
        })),
      ];
    }),

    create: requireRole('admin')
      .input(templateFields)
      .mutation(({ ctx, input }) =>
        ctx.inOrg(async (tx) => {
          const [row] = await tx
            .insert(promptTemplates)
            .values({ orgId: ctx.orgId, ...input, createdBy: ctx.userId })
            .onConflictDoNothing()
            .returning();
          if (!row) throw new TRPCError({ code: 'CONFLICT', message: `A template named "${input.name}" already exists` });
          await ctx.audit(tx, { action: 'prompt_template.created', targetType: 'prompt_template', targetId: row.id, metadata: { name: row.name, kind: row.kind } });
          return row;
        }),
      ),

    update: requireRole('admin')
      .input(templateFields.partial().extend({ id: z.string().uuid() }))
      .mutation(({ ctx, input }) =>
        ctx.inOrg(async (tx) => {
          const { id, ...patch } = input;
          if (patch.name) {
            const [clash] = await tx
              .select({ id: promptTemplates.id })
              .from(promptTemplates)
              .where(and(eq(promptTemplates.orgId, ctx.orgId), eq(promptTemplates.name, patch.name)));
            if (clash && clash.id !== id) throw new TRPCError({ code: 'CONFLICT', message: `A template named "${patch.name}" already exists` });
          }
          const [row] = await tx
            .update(promptTemplates)
            .set({ ...patch, updatedAt: new Date() })
            .where(and(eq(promptTemplates.id, id), eq(promptTemplates.orgId, ctx.orgId)))
            .returning();
          if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Template not found' });
          await ctx.audit(tx, { action: 'prompt_template.updated', targetType: 'prompt_template', targetId: row.id, metadata: { fields: Object.keys(patch) } });
          return row;
        }),
      ),

    delete: requireRole('admin')
      .input(z.object({ id: z.string().uuid() }))
      .mutation(({ ctx, input }) =>
        ctx.inOrg(async (tx) => {
          const [gone] = await tx
            .delete(promptTemplates)
            .where(and(eq(promptTemplates.id, input.id), eq(promptTemplates.orgId, ctx.orgId)))
            .returning();
          if (!gone) throw new TRPCError({ code: 'NOT_FOUND', message: 'Template not found' });
          await ctx.audit(tx, { action: 'prompt_template.deleted', targetType: 'prompt_template', targetId: gone.id, metadata: { name: gone.name } });
          return { ok: true };
        }),
      ),
  }),
});
