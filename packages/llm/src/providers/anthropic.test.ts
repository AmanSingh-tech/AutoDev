import { http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ANTHROPIC, apiError, messageStream, modelsOk } from '../../test/anthropic-mock';
import { AnthropicProvider, usageEntries } from './anthropic';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const provider = new AnthropicProvider({ baseURL: ANTHROPIC, maxRetries: 0 });
const creds = { apiKey: 'sk-ant-test-1234', config: {} };

describe('AnthropicProvider.complete', () => {
  it('sends caching, effort and fallback options, and maps the streamed response', async () => {
    let body: Record<string, unknown> = {};
    let headers = new Headers();
    server.use(
      http.post(`${ANTHROPIC}/v1/messages`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        headers = request.headers;
        return messageStream({
          content: [
            { type: 'thinking', thinking: '', signature: 'sig' },
            { type: 'text', text: 'Reading the file.' },
            { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'README.md' } },
          ],
          stopReason: 'tool_use',
          usage: {
            input_tokens: 120,
            output_tokens: 40,
            cache_creation_input_tokens: 2000,
            cache_read_input_tokens: 500,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 },
          },
        });
      }),
    );

    const res = await provider.complete(
      {
        model: 'claude-opus-5-5',
        system: [{ text: 'You are AutoDev.', cache: '1h' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Fix the bug' }] }],
        tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
        maxOutputTokens: 64_000,
        effort: 'high',
        cacheConversation: true,
        refusalFallback: true,
      },
      creds,
    );

    expect(headers.get('x-api-key')).toBe('sk-ant-test-1234');
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 64_000,
      stream: true,
      fallbacks: 'default',
      output_config: { effort: 'high' },
      cache_control: { type: 'ephemeral' },
      system: [{ type: 'text', text: 'You are AutoDev.', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    });
    expect(body).not.toHaveProperty('thinking');

    expect(res.stopReason).toBe('tool_use');
    expect(res.requestId).toBe('req_test_1');
    expect(res.content).toEqual([
      { type: 'opaque', provider: 'anthropic', block: { type: 'thinking', thinking: '', signature: 'sig' } },
      { type: 'text', text: 'Reading the file.' },
      { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'README.md' } },
    ]);
    expect(res.usage).toEqual([
      { model: 'claude-opus-5-5', inputTokens: 120, outputTokens: 40, cacheWrite5mTokens: 0, cacheWrite1hTokens: 2000, cacheReadTokens: 500 },
    ]);
  });

  it('replays opaque blocks verbatim on the next turn', async () => {
    let body: { messages?: { content: unknown[] }[] } = {};
    server.use(
      http.post(`${ANTHROPIC}/v1/messages`, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return messageStream({ content: [{ type: 'text', text: 'ok' }] });
      }),
    );
    const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
    await provider.complete(
      {
        model: 'claude-opus-5-5',
        system: [],
        maxOutputTokens: 1000,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          { role: 'assistant', content: [{ type: 'opaque', provider: 'anthropic', block: thinking }, { type: 'tool_use', id: 't', name: 'x', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', toolUseId: 't', content: 'done', isError: true }] },
        ],
      },
      creds,
    );
    expect(body.messages![1]!.content[0]).toEqual(thinking);
    expect(body.messages![2]!.content[0]).toEqual({ type: 'tool_result', tool_use_id: 't', content: 'done', is_error: true });
  });

  it.each([
    [401, 'authentication_error', 'auth', true],
    [403, 'permission_error', 'permission', true],
    [402, 'billing_error', 'billing', true],
    [429, 'rate_limit_error', 'rate_limit', false],
    [529, 'overloaded_error', 'overloaded', false],
    [500, 'api_error', 'server', false],
    [400, 'invalid_request_error', 'bad_request', false],
  ])('classifies HTTP %i as %s', async (status, type, kind, isKeyFailure) => {
    server.use(http.post(`${ANTHROPIC}/v1/messages`, () => apiError(status, type)));
    const err = await provider
      .complete({ model: 'claude-opus-5-5', system: [], messages: [], maxOutputTokens: 10 }, creds)
      .catch((e) => e);
    expect(err.kind).toBe(kind);
    expect(err.isKeyFailure).toBe(isKeyFailure);
    expect(err.message).not.toContain('sk-ant');
  });
});

describe('AnthropicProvider.validateKey', () => {
  it('accepts a working key via the free models endpoint', async () => {
    server.use(modelsOk());
    await expect(provider.validateKey(creds)).resolves.toEqual({ ok: true });
  });

  it('reports a rejected key', async () => {
    server.use(http.get(`${ANTHROPIC}/v1/models`, () => apiError(401, 'authentication_error')));
    await expect(provider.validateKey(creds)).resolves.toMatchObject({ ok: false, kind: 'auth' });
  });
});

describe('usageEntries', () => {
  it('splits usage by model when a fallback served the request', () => {
    const entries = usageEntries(
      {
        model: 'claude-opus-5',
        usage: {
          input_tokens: 999,
          output_tokens: 999,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: null,
          iterations: [
            { type: 'message', model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
            { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
          ],
        } as never,
      },
      'claude-opus-5-5',
    );
    expect(entries.map((e) => [e.model, e.inputTokens, e.outputTokens])).toEqual([
      ['claude-opus-5-5', 100, 3],
      ['claude-opus-5', 100, 50],
    ]);
  });
});
