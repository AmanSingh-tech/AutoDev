import type { LlmUseCase } from '@autodev/db';
import type { Effort, ProviderId } from './types';

export interface ModelPolicy {
  provider: ProviderId;
  model: string;
  maxTokensPerTask: number;
  maxOutputTokens: number;
  effort: Effort | null;
}

/** Used until an org saves its own policy for the use case. */
export const DEFAULT_POLICIES: Record<LlmUseCase, ModelPolicy> = {
  agent: {
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    maxTokensPerTask: 3_000_000,
    maxOutputTokens: 64_000,
    // Claude Opus 5.5 defaults to medium; agentic coding benefits from high.
    effort: 'high',
  },
  chat: {
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    // Chats have no task, so the per-task cap doesn't apply. Monthly budgets still do.
    maxTokensPerTask: 3_000_000,
    maxOutputTokens: 4_000,
    // Answers are short, and reading files doesn't need deep reasoning.
    effort: null,
  },
};
