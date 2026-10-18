import { LlmBlocked } from './errors';
import { AnthropicProvider, type AnthropicProviderOptions } from './providers/anthropic';
import type { LlmProvider, ProviderId } from './types';

export interface ProviderRegistry {
  get(id: ProviderId): LlmProvider;
}

/** OpenAI, Azure OpenAI and Bedrock plug in here by implementing LlmProvider. */
export function createProviderRegistry(opts: { anthropic?: AnthropicProviderOptions } = {}): ProviderRegistry {
  const providers = new Map<ProviderId, LlmProvider>([['anthropic', new AnthropicProvider(opts.anthropic)]]);
  return {
    get(id) {
      const p = providers.get(id);
      if (!p) throw new LlmBlocked('provider_unsupported', `The ${id} provider isn't available yet`);
      return p;
    },
  };
}

/** Test helper / custom wiring. */
export const staticRegistry = (providers: LlmProvider[]): ProviderRegistry => ({
  get(id) {
    const p = providers.find((x) => x.id === id);
    if (!p) throw new LlmBlocked('provider_unsupported', `The ${id} provider isn't available yet`);
    return p;
  },
});
