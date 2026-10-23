import { LlmBlocked } from './errors';
import { AnthropicProvider, type AnthropicProviderOptions } from './providers/anthropic';
import { BedrockProvider, type BedrockProviderOptions } from './providers/bedrock';
import { AzureOpenAiProvider, OpenAiProvider, type OpenAiProviderOptions } from './providers/openai';
import type { LlmProvider, ProviderId } from './types';

export interface ProviderRegistry {
  get(id: ProviderId): LlmProvider;
}

/** Anthropic, plus OpenAI, Azure OpenAI and Bedrock (B-7). */
export function createProviderRegistry(
  opts: { anthropic?: AnthropicProviderOptions; openai?: OpenAiProviderOptions; azureOpenai?: OpenAiProviderOptions; bedrock?: BedrockProviderOptions } = {},
): ProviderRegistry {
  const providers = new Map<ProviderId, LlmProvider>([
    ['anthropic', new AnthropicProvider(opts.anthropic)],
    ['openai', new OpenAiProvider(opts.openai)],
    ['azure_openai', new AzureOpenAiProvider(opts.azureOpenai)],
    ['bedrock', new BedrockProvider(opts.bedrock)],
  ]);
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
