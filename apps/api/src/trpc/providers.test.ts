import { schema } from '@autodev/db';
import { makeOrg, truncateAll } from '@autodev/db/testing';
import { CredentialService, createProviderRegistry, LlmGateway } from '@autodev/llm';
import { testKms } from '@autodev/db/testing';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, callerFor, createTestDeps, msw } from '../../test/harness';

const h = createTestDeps();
// The real registry, with OpenAI and Bedrock pointed at mocks.
const providers = createProviderRegistry({ openai: { baseURL: 'http://openai.test' }, bedrock: { baseURL: 'http://bedrock.test' } });
const credentials = new CredentialService({ app: h.deps.app, sys: h.deps.sys, kms: testKms, providers });
const deps = { ...h.deps, providers, credentials, gateway: new LlmGateway({ sys: h.deps.sys, providers, credentials }) };
beforeAll(() => msw.listen({ onUnhandledRequest: 'error' }));
afterEach(() => msw.resetHandlers());
afterAll(async () => {
  msw.close();
  await h.close();
});

let fx: Awaited<ReturnType<typeof makeOrg>>;
let admin: { id: string };
beforeEach(async () => {
  await truncateAll(deps.sys);
  fx = await makeOrg(deps.sys, 'acme');
  admin = await addMember(deps, fx.org.id, 'admin', 'admin');
});
const as = (u: { id: string }) => callerFor(deps, u.id, fx.org.id);
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code);

describe('more LLM providers (B-7)', () => {
  it('checks and stores OpenAI and Bedrock keys with their settings, and needs the provider settings', async () => {
    msw.use(
      http.get('http://openai.test/v1/models', () => HttpResponse.json({ data: [] })),
      http.get('http://bedrock.test/foundation-models', () => HttpResponse.json({ modelSummaries: [] })),
    );
    expect(await code(as(admin).llmKeys.create({ scope: 'org', provider: 'bedrock', label: 'b', apiKey: 'bedrock-key-0123456789abcdef' }))).toBe('BAD_REQUEST');
    expect(await code(as(admin).llmKeys.create({ scope: 'org', provider: 'azure_openai', label: 'a', apiKey: 'azure-key-0123456789abcdef', config: { resource: 'https://evil' } }))).toBe('BAD_REQUEST');

    await as(admin).llmKeys.create({ scope: 'org', provider: 'openai', label: 'OpenAI', apiKey: 'sk-openai-0123456789abcdef' });
    await as(admin).llmKeys.create({ scope: 'org', provider: 'bedrock', label: 'Bedrock', apiKey: 'bedrock-key-0123456789abcdef', config: { region: 'us-east-1' } });
    const keys = await as(admin).llmKeys.list();
    expect(keys.map((k) => [k.provider, k.config])).toEqual(expect.arrayContaining([['openai', {}], ['bedrock', { region: 'us-east-1' }]]));
    expect(JSON.stringify(keys)).not.toContain('0123456789abcdef');
  });

  it('lets the agent use another provider’s model once it has a price', async () => {
    const policy = { useCase: 'agent' as const, provider: 'openai' as const, model: 'gpt-x', maxTokensPerTask: 1_000_000, maxOutputTokens: 16_000, effort: null };
    expect(await code(as(admin).models.setPolicy(policy))).toBe('BAD_REQUEST');
    await as(admin).models.setPrice({ provider: 'openai', model: 'gpt-x', inputPerMtok: '1', outputPerMtok: '4', cacheWrite5mPerMtok: '0', cacheWrite1hPerMtok: '0', cacheReadPerMtok: '0.25' });
    await as(admin).models.setPolicy(policy);
    expect((await as(admin).models.policies()).find((p) => p.useCase === 'agent')).toMatchObject({ provider: 'openai', model: 'gpt-x', isDefault: false });
    // Same model name under another provider is a different price.
    expect((await as(admin).models.prices()).filter((p) => p.model === 'gpt-x').map((p) => p.provider)).toEqual(['openai']);
    expect(await deps.sys.select().from(schema.modelPrices)).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'openai', model: 'gpt-x', orgId: fx.org.id })]));
  });
});
