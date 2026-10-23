export type Provider = 'anthropic' | 'openai' | 'azure_openai' | 'bedrock';
/** B-7: Anthropic, OpenAI, Azure OpenAI and Claude on Amazon Bedrock. */
export const PROVIDERS: Record<Provider, { label: string; keyLabel: string; placeholder: string }> = {
  anthropic: { label: 'Anthropic', keyLabel: 'Anthropic API key', placeholder: 'sk-ant-…' },
  openai: { label: 'OpenAI', keyLabel: 'OpenAI API key', placeholder: 'sk-…' },
  azure_openai: { label: 'Azure OpenAI', keyLabel: 'Azure OpenAI key', placeholder: 'Key 1 or Key 2 from the resource' },
  bedrock: { label: 'Amazon Bedrock', keyLabel: 'Bedrock API key', placeholder: 'An Amazon Bedrock API key' },
};
export const providerLabel = (p: string) => PROVIDERS[p as Provider]?.label ?? p;
