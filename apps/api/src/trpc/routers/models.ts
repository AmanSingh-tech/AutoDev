import { and, asc, eq, isNull, LLM_USE_CASES, or, schema, sql } from '@autodev/db';
import { DEFAULT_POLICIES } from '@autodev/llm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';

const { modelPolicies, modelPrices } = schema;

const provider = z.enum(['anthropic', 'openai', 'azure_openai', 'bedrock']).default('anthropic');

const money = z
  .string()
  .regex(/^\d{1,6}(\.\d{1,6})?$/, 'Up to 6 decimals')
  .or(z.number().nonnegative().transform((n) => n.toFixed(6)));

async function currentPrices(tx: Parameters<Parameters<import('@autodev/db').AppDb['transaction']>[0]>[0], orgId: string) {
  const rows = await tx
    .select()
    .from(modelPrices)
    .where(and(isNull(modelPrices.effectiveTo), or(isNull(modelPrices.orgId), eq(modelPrices.orgId, orgId))))
    .orderBy(asc(modelPrices.model));
  // An org override replaces the global row for the same model.
  const byModel = new Map<string, (typeof rows)[number] & { overridden: boolean; global: (typeof rows)[number] | null }>();
  for (const r of rows.filter((r) => r.orgId === null)) byModel.set(`${r.provider}/${r.model}`, { ...r, overridden: false, global: r });
  for (const r of rows.filter((r) => r.orgId !== null)) {
    const key = `${r.provider}/${r.model}`;
    byModel.set(key, { ...r, overridden: true, global: byModel.get(key)?.global ?? null });
  }
  return [...byModel.values()];
}

export const modelsRouter = router({
  policies: orgProcedure.query(({ ctx }) =>
    ctx.inOrg(async (tx) => {
      const saved = await tx.select().from(modelPolicies).where(eq(modelPolicies.orgId, ctx.orgId));
      return LLM_USE_CASES.map((useCase) => {
        const s = saved.find((p) => p.useCase === useCase);
        const d = DEFAULT_POLICIES[useCase];
        return s
          ? { useCase, provider: s.provider, model: s.model, maxTokensPerTask: s.maxTokensPerTask, maxOutputTokens: s.maxOutputTokens, effort: s.effort, isDefault: false }
          : { useCase, ...d, isDefault: true };
      });
    }),
  ),

  setPolicy: adminProcedure
    .input(
      z.object({
        useCase: z.enum(LLM_USE_CASES),
        /** B-7: OpenAI, Azure OpenAI (the deployment name is the model) and Bedrock (the model or inference-profile id). */
        provider,
        model: z.string().min(1).max(100),
        maxTokensPerTask: z.number().int().min(10_000).max(100_000_000),
        maxOutputTokens: z.number().int().min(1_000).max(128_000),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.inOrg(async (tx) => {
        const priced = (await currentPrices(tx, ctx.orgId)).some((p) => p.provider === input.provider && p.model === input.model);
        if (!priced) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Add a price for this model first, so its usage can be metered' });
        const values = { ...input, orgId: ctx.orgId, updatedBy: ctx.userId };
        const [row] = await tx
          .insert(modelPolicies)
          .values(values)
          .onConflictDoUpdate({ target: [modelPolicies.orgId, modelPolicies.useCase], set: values })
          .returning();
        await ctx.audit(tx, { action: 'model_policy.updated', targetType: 'model_policy', targetId: row!.id, metadata: input });
        return row!;
      }),
    ),

  prices: orgProcedure.query(({ ctx }) => ctx.inOrg((tx) => currentPrices(tx, ctx.orgId))),

  /** Edits are effective-dated: the current override is closed and a new one starts now. History stays priced as it was. */
  setPrice: adminProcedure
    .input(
      z.object({
        provider,
        model: z.string().min(1).max(100),
        inputPerMtok: money,
        outputPerMtok: money,
        cacheWrite5mPerMtok: money,
        cacheWrite1hPerMtok: money,
        cacheReadPerMtok: money,
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.inOrg(async (tx) => {
        const now = new Date();
        await tx
          .update(modelPrices)
          .set({ effectiveTo: now })
          .where(and(eq(modelPrices.orgId, ctx.orgId), eq(modelPrices.provider, input.provider), eq(modelPrices.model, input.model), isNull(modelPrices.effectiveTo)));
        const [row] = await tx
          .insert(modelPrices)
          .values({ ...input, orgId: ctx.orgId, effectiveFrom: now, updatedBy: ctx.userId })
          .returning();
        await ctx.audit(tx, { action: 'model_price.updated', targetType: 'model_price', targetId: row!.id, metadata: input });
        return row!;
      }),
    ),

  clearPriceOverride: adminProcedure.input(z.object({ provider, model: z.string() })).mutation(({ ctx, input }) =>
    ctx.inOrg(async (tx) => {
      const closed = await tx
        .update(modelPrices)
        .set({ effectiveTo: sql`now()` })
        .where(and(eq(modelPrices.orgId, ctx.orgId), eq(modelPrices.provider, input.provider), eq(modelPrices.model, input.model), isNull(modelPrices.effectiveTo)))
        .returning({ id: modelPrices.id });
      if (closed.length) await ctx.audit(tx, { action: 'model_price.override_cleared', targetType: 'model_price', targetId: closed[0]!.id, metadata: input });
      return { ok: true };
    }),
  ),
});
