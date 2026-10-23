import { and, eq, isNull, or, schema, sql, type LlmUseCase, type SystemDb } from '@autodev/db';
import { uuidv7 } from 'uuidv7';
import { budgetStatus, groupAgentBudget, sendBudgetAlerts } from './budgets';
import type { CredentialService } from './credentials';
import { DEFAULT_POLICIES, type ModelPolicy } from './defaults';
import { KeyFailure, LlmBlocked, LlmError } from './errors';
import { cappedTokens, costUsd } from './pricing';
import type { ProviderRegistry } from './registry';
import type { LlmRequest, LlmResponse, ProviderId } from './types';

const { llmCredentials, modelPolicies, modelPrices, orgMembers, orgs, teamMembers, tokenUsage } = schema;

export interface CallContext {
  orgId: string;
  /** Whose key and budget apply. Null for org-level system work. */
  userId: string | null;
  repoId?: string | null;
  taskId?: string | null;
  agentRunId?: string | null;
  useCase: LlmUseCase;
  /** Per-task override of the policy's token cap. */
  taskTokenCap?: number | null;
}

export type GatewayRequest = Omit<LlmRequest, 'model' | 'maxOutputTokens' | 'effort'> & { maxOutputTokens?: number };

export interface GatewayResult {
  response: LlmResponse;
  costUsd: string;
  credentialId: string;
}

export interface ResolvedCredential {
  id: string;
  scope: 'org' | 'team' | 'user';
  last4: string;
}

/**
 * The only path to an LLM. It picks the key (user, then team, then org), enforces the per-task
 * token cap, decrypts the key for exactly one call, and meters every call from the provider's
 * own usage fields. Runs as the system role and scopes every query by orgId explicitly.
 */
export class LlmGateway {
  constructor(
    private readonly deps: { sys: SystemDb; providers: ProviderRegistry; credentials: CredentialService },
  ) {}

  async policy(orgId: string, useCase: LlmUseCase): Promise<ModelPolicy> {
    const [p] = await this.deps.sys
      .select()
      .from(modelPolicies)
      .where(and(eq(modelPolicies.orgId, orgId), eq(modelPolicies.useCase, useCase)));
    if (!p) return DEFAULT_POLICIES[useCase];
    return {
      provider: p.provider,
      model: p.model,
      maxTokensPerTask: p.maxTokensPerTask,
      maxOutputTokens: p.maxOutputTokens,
      effort: (p.effort as ModelPolicy['effort']) ?? null,
    };
  }

  /** The most specific active key: the user's own, then their team's, then the org's. */
  async resolveCredential(orgId: string, userId: string | null, provider: ProviderId): Promise<ResolvedCredential | null> {
    const { sys } = this.deps;
    const active = and(eq(llmCredentials.orgId, orgId), eq(llmCredentials.provider, provider), eq(llmCredentials.status, 'active'));
    const pick = { id: llmCredentials.id, scope: llmCredentials.scope, last4: llmCredentials.last4, teamId: llmCredentials.teamId };

    if (userId) {
      const [org] = await sys.select({ allowUserKeys: orgs.allowUserKeys }).from(orgs).where(eq(orgs.id, orgId));
      if (org?.allowUserKeys) {
        const [mine] = await sys.select(pick).from(llmCredentials).where(and(active, eq(llmCredentials.scope, 'user'), eq(llmCredentials.userId, userId)));
        if (mine) return mine;
      }
      const teamKeys = await sys
        .select(pick)
        .from(llmCredentials)
        .innerJoin(teamMembers, and(eq(teamMembers.teamId, llmCredentials.teamId), eq(teamMembers.userId, userId)))
        .where(and(active, eq(llmCredentials.scope, 'team')));
      if (teamKeys.length === 1) return teamKeys[0]!;
      if (teamKeys.length > 1) {
        // In several teams with keys: the member's primary team decides. Without one, fall through to the org key.
        const [m] = await sys
          .select({ primaryTeamId: orgMembers.primaryTeamId })
          .from(orgMembers)
          .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
        const primary = teamKeys.find((k) => k.teamId === m?.primaryTeamId);
        if (primary) return primary;
      }
    }
    const [orgKey] = await sys.select(pick).from(llmCredentials).where(and(active, eq(llmCredentials.scope, 'org')));
    return orgKey ?? null;
  }

  /**
   * Checked before a new agent run starts: there must be a usable key, and no hard budget may be
   * exhausted. Runs already in progress aren't stopped by budgets; the per-task cap bounds them.
   */
  async assertRunAllowed(orgId: string, userId: string | null, useCase: LlmUseCase = 'agent') {
    const policy = await this.policy(orgId, useCase);
    if (!(await this.resolveCredential(orgId, userId, policy.provider))) {
      throw new LlmBlocked('no_credential', 'No working LLM key is configured for this organization.');
    }
    if (useCase === 'group_agent') await this.assertGroupAgentBudget(orgId);
    const blocked = (await budgetStatus(this.deps.sys, orgId, userId)).find((b) => b.overHard && b.hardBlock);
    if (blocked) {
      throw new LlmBlocked(
        'budget_exceeded',
        blocked.scope === 'org' ? "The organization's monthly AI budget is used up." : 'Your monthly AI budget is used up.',
        { scope: blocked.scope, limitUsd: blocked.limitUsd, spentUsd: blocked.spentUsd },
      );
    }
  }

  /** The Group Agent's own monthly budget (B-5). Checked before its runs and before each of its calls. */
  private async assertGroupAgentBudget(orgId: string) {
    const { limitUsd, spentUsd } = await groupAgentBudget(this.deps.sys, orgId);
    if (limitUsd !== null && spentUsd >= limitUsd)
      throw new LlmBlocked('budget_exceeded', "The Group Agent's monthly AI budget is used up.", { scope: 'group_agent', limitUsd, spentUsd });
  }

  async taskTokensUsed(orgId: string, taskId: string): Promise<number> {
    const [row] = await this.deps.sys
      .select({
        n: sql<string>`coalesce(sum(${tokenUsage.inputTokens} + ${tokenUsage.outputTokens} + ${tokenUsage.cacheWrite5mTokens} + ${tokenUsage.cacheWrite1hTokens}), 0)`,
      })
      .from(tokenUsage)
      .where(and(eq(tokenUsage.orgId, orgId), eq(tokenUsage.taskId, taskId)));
    return Number(row?.n ?? 0);
  }

  async call(ctx: CallContext, req: GatewayRequest, opts: { signal?: AbortSignal } = {}): Promise<GatewayResult> {
    const policy = await this.policy(ctx.orgId, ctx.useCase);
    if (ctx.useCase === 'group_agent') await this.assertGroupAgentBudget(ctx.orgId);

    let maxOutputTokens = Math.min(policy.maxOutputTokens, req.maxOutputTokens ?? Number.POSITIVE_INFINITY);
    if (ctx.taskId) {
      const cap = ctx.taskTokenCap ?? policy.maxTokensPerTask;
      const used = await this.taskTokensUsed(ctx.orgId, ctx.taskId);
      if (used >= cap) {
        throw new LlmBlocked('task_token_cap', `This task reached its token cap (${cap.toLocaleString('en-US')} tokens).`, { cap, used });
      }
      maxOutputTokens = Math.min(maxOutputTokens, cap - used);
    }

    const cred = await this.resolveCredential(ctx.orgId, ctx.userId, policy.provider);
    if (!cred) throw new LlmBlocked('no_credential', 'No working LLM key is configured for this organization.');

    const provider = this.deps.providers.get(policy.provider);
    let response: LlmResponse;
    try {
      response = await this.deps.credentials.withSecret(cred.id, (apiKey, config) =>
        provider.complete(
          { ...req, model: policy.model, maxOutputTokens, ...(policy.effort ? { effort: policy.effort } : {}) },
          { apiKey, config },
          opts,
        ),
      );
    } catch (e) {
      if (e instanceof LlmError && e.isKeyFailure) {
        await this.deps.credentials.markInvalid(cred.id, e);
        throw new KeyFailure(cred.id, e);
      }
      throw e;
    }

    const total = await this.meter(ctx, policy.provider, cred, response);
    await sendBudgetAlerts(this.deps.sys, ctx.orgId, ctx.userId);
    return { response, costUsd: total, credentialId: cred.id };
  }

  /** One token_usage row per model that ran. The cost is computed now and frozen. */
  private async meter(ctx: CallContext, provider: ProviderId, cred: ResolvedCredential, res: LlmResponse): Promise<string> {
    const { sys } = this.deps;
    let totalMicro = 0n;
    for (const u of res.usage) {
      const [price] = await sys
        .select()
        .from(modelPrices)
        .where(
          and(
            eq(modelPrices.provider, provider),
            eq(modelPrices.model, u.model),
            isNull(modelPrices.effectiveTo),
            or(eq(modelPrices.orgId, ctx.orgId), isNull(modelPrices.orgId)),
          ),
        )
        .orderBy(sql`${modelPrices.orgId} is null`)
        .limit(1);
      const cost = price ? costUsd(u, price) : '0.000000';
      totalMicro += BigInt(cost.replace('.', ''));
      await sys.insert(tokenUsage).values({
        id: uuidv7(),
        orgId: ctx.orgId,
        userId: ctx.userId,
        repoId: ctx.repoId ?? null,
        taskId: ctx.taskId ?? null,
        agentRunId: ctx.agentRunId ?? null,
        credentialId: cred.id,
        credentialScope: cred.scope,
        provider,
        model: u.model,
        useCase: ctx.useCase,
        providerRequestId: res.requestId,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheWrite5mTokens: u.cacheWrite5mTokens,
        cacheWrite1hTokens: u.cacheWrite1hTokens,
        cacheReadTokens: u.cacheReadTokens,
        costUsd: cost,
        priced: !!price,
        modelPriceId: price?.id ?? null,
      });
    }
    const s = totalMicro.toString().padStart(7, '0');
    return `${s.slice(0, -6)}.${s.slice(-6)}`;
  }
}
