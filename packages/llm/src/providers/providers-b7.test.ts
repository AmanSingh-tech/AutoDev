import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LlmRequest } from '../types';
import { BedrockProvider } from './bedrock';
import { AzureOpenAiProvider, OpenAiProvider } from './openai';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** A tool round trip: the assistant called read_file, and the user turn carries the result. */
const request: LlmRequest = {
  model: 'm',
  system: [{ text: 'You are careful.' }, { text: 'Repo rules.', cache: '1h' }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Fix it' }] },
    {
      role: 'assistant',
      content: [
        { type: 'opaque', provider: 'anthropic', block: { type: 'thinking', thinking: '', signature: 's' } },
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'export {}', isError: false }] },
  ],
  tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
  maxOutputTokens: 1000,
  effort: 'xhigh',
};

const completion = (o: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-1',
  model: 'gpt-x',
  choices: [{ message: { content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.ts"}' } }] }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } },
  ...o,
});

describe('OpenAI', () => {
  const provider = new OpenAiProvider({ baseURL: 'http://openai.test' });
  const creds = { apiKey: 'sk-openai-test-123456789', config: {} };

  it('translates messages and tools to Chat Completions, and usage back with cached tokens', async () => {
    let body: Record<string, unknown> = {};
    let auth: string | null = null;
    server.use(
      http.post('http://openai.test/v1/chat/completions', async ({ request: r }) => {
        body = (await r.json()) as Record<string, unknown>;
        auth = r.headers.get('authorization');
        return HttpResponse.json(completion(), { headers: { 'x-request-id': 'req_1' } });
      }),
    );
    const res = await provider.complete(request, creds);
    expect(auth).toBe('Bearer sk-openai-test-123456789');
    expect(body).toMatchObject({
      model: 'm',
      max_completion_tokens: 1000,
      reasoning_effort: 'high',
      messages: [
        { role: 'system', content: 'You are careful.\n\nRepo rules.' },
        { role: 'user', content: 'Fix it' },
        { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'export {}' },
      ],
      tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file' } }],
    });
    expect(res).toEqual({
      model: 'gpt-x',
      content: [{ type: 'tool_use', id: 'call_2', name: 'read_file', input: { path: 'b.ts' } }],
      stopReason: 'tool_use',
      usage: [{ model: 'gpt-x', inputTokens: 200, outputTokens: 50, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 800 }],
      requestId: 'req_1',
    });
  });

  it('maps errors to kinds without echoing the key, and validates keys by listing models', async () => {
    server.use(
      http.post('http://openai.test/v1/chat/completions', () => HttpResponse.json({ error: { code: 'insufficient_quota', message: 'sk-openai-test-123456789' } }, { status: 429 })),
      http.get('http://openai.test/v1/models', ({ request: r }) =>
        r.headers.get('authorization') === 'Bearer good-key-123456789012' ? HttpResponse.json({ data: [] }) : HttpResponse.json({ error: { code: 'invalid_api_key' } }, { status: 401 }),
      ),
    );
    const err = await provider.complete(request, creds).catch((e) => e);
    expect(err).toMatchObject({ kind: 'billing', status: 429 });
    expect(err.message).not.toContain('sk-openai');
    expect(await provider.validateKey({ apiKey: 'good-key-123456789012', config: {} })).toEqual({ ok: true });
    expect(await provider.validateKey(creds)).toMatchObject({ ok: false, kind: 'auth' });
  });
});

describe('Azure OpenAI', () => {
  it('calls the deployment on the resource with the api-key header, and refuses a bad resource name', async () => {
    let url = '';
    let key: string | null = null;
    const provider = new AzureOpenAiProvider();
    server.use(
      http.post('https://acme-ai.openai.azure.com/openai/deployments/:deployment/chat/completions', ({ request: r }) => {
        url = r.url;
        key = r.headers.get('api-key');
        return HttpResponse.json(completion({ choices: [{ message: { content: 'Done.' }, finish_reason: 'stop' }] }));
      }),
    );
    const res = await provider.complete({ ...request, model: 'gpt-prod' }, { apiKey: 'azure-key-0123456789abcdef', config: { resource: 'acme-ai' } });
    expect(url).toBe('https://acme-ai.openai.azure.com/openai/deployments/gpt-prod/chat/completions?api-version=2024-10-21');
    expect(key).toBe('azure-key-0123456789abcdef');
    expect(res).toMatchObject({ content: [{ type: 'text', text: 'Done.' }], stopReason: 'end_turn' });

    await expect(provider.complete(request, { apiKey: 'k'.repeat(20), config: { resource: 'evil.com/x?' } })).rejects.toMatchObject({ kind: 'bad_request' });
  });
});

describe('Bedrock', () => {
  const provider = new BedrockProvider();
  const creds = { apiKey: 'bedrock-api-key-abcdefghijklmnop', config: { region: 'eu-central-1' } };

  it('invokes the model with the Anthropic body and bearer key, replays Claude blocks, and meters by the requested model', async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post('https://bedrock-runtime.eu-central-1.amazonaws.com/model/:model/invoke', async ({ request: r, params }) => {
        expect(params.model).toBe('eu.anthropic.claude-x');
        expect(r.headers.get('authorization')).toBe('Bearer bedrock-api-key-abcdefghijklmnop');
        body = (await r.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            id: 'msg_1',
            model: 'claude-x',
            content: [
              { type: 'thinking', thinking: '', signature: 't' },
              { type: 'text', text: 'Fixed.' },
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
          },
          { headers: { 'x-amzn-requestid': 'aws-1' } },
        );
      }),
    );
    const res = await provider.complete({ ...request, model: 'eu.anthropic.claude-x' }, creds);
    expect(body).toMatchObject({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 1000, system: [{ type: 'text', text: 'You are careful.' }, { type: 'text', text: 'Repo rules.', cache_control: { type: 'ephemeral', ttl: '1h' } }] });
    expect((body.messages as { content: { type: string }[] }[])[1]!.content[0]).toEqual({ type: 'thinking', thinking: '', signature: 's' });
    expect(res).toMatchObject({
      content: [{ type: 'opaque', provider: 'bedrock' }, { type: 'text', text: 'Fixed.' }],
      stopReason: 'end_turn',
      usage: [{ model: 'eu.anthropic.claude-x', inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWrite5mTokens: 20 }],
      requestId: 'aws-1',
    });
  });

  it('maps AWS error types and needs a valid region', async () => {
    server.use(
      http.post('https://bedrock-runtime.eu-central-1.amazonaws.com/model/:model/invoke', () => HttpResponse.json({ message: 'denied' }, { status: 403, headers: { 'x-amzn-errortype': 'AccessDeniedException:http://internal' } })),
      http.get('https://bedrock.eu-central-1.amazonaws.com/foundation-models', () => HttpResponse.json({ message: 'bad' }, { status: 403, headers: { 'x-amzn-errortype': 'UnrecognizedClientException' } })),
    );
    await expect(provider.complete(request, creds)).rejects.toMatchObject({ kind: 'permission' });
    expect(await provider.validateKey(creds)).toMatchObject({ ok: false, kind: 'auth' });
    await expect(provider.complete(request, { ...creds, config: { region: 'evil.example.com#' } })).rejects.toMatchObject({ kind: 'bad_request' });
  });
});
