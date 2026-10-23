import { LlmError, type LlmErrorKind } from '../errors';
import type { ContentBlock, KeyCheck, LlmProvider, LlmRequest, LlmResponse, Message, ProviderCredentials, StopReason } from '../types';

/**
 * OpenAI and Azure OpenAI (B-7), over the Chat Completions REST API with fetch. Both speak the
 * same format; they differ in the URL and the auth header. Azure's model is the deployment name.
 */
export interface OpenAiProviderOptions {
  /** Platform-level override, for tests only. Never taken from admin-supplied config (SSRF). */
  baseURL?: string;
  timeoutMs?: number;
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatCompletion {
  id?: string;
  model: string;
  choices: { message: { content: string | null; refusal?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

abstract class ChatCompletionsProvider implements LlmProvider {
  abstract readonly id: 'openai' | 'azure_openai';
  protected abstract label: string;
  constructor(protected readonly opts: OpenAiProviderOptions = {}) {}

  protected abstract endpoint(creds: ProviderCredentials, model: string): string;
  protected abstract modelsEndpoint(creds: ProviderCredentials): string;
  protected abstract headers(creds: ProviderCredentials): Record<string, string>;

  async complete(req: LlmRequest, creds: ProviderCredentials, opts: { signal?: AbortSignal } = {}): Promise<LlmResponse> {
    const body = {
      model: req.model,
      messages: toChatMessages(req),
      max_completion_tokens: req.maxOutputTokens,
      ...(req.tools?.length
        ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema, ...(t.strict ? { strict: true } : {}) } })) }
        : {}),
      // Reasoning models take low/medium/high; the higher settings map to high.
      ...(req.effort ? { reasoning_effort: req.effort === 'low' || req.effort === 'medium' ? req.effort : 'high' } : {}),
    };
    const res = await this.fetch(this.endpoint(creds, req.model), { method: 'POST', headers: { 'content-type': 'application/json', ...this.headers(creds) }, body: JSON.stringify(body) }, opts.signal);
    const data = (await res.json()) as ChatCompletion;
    const choice = data.choices[0];
    if (!choice) throw new LlmError('server', `${this.label} returned no choices`);
    const content: ContentBlock[] = [];
    if (choice.message.content) content.push({ type: 'text', text: choice.message.content });
    if (choice.message.refusal) content.push({ type: 'text', text: choice.message.refusal });
    for (const call of choice.message.tool_calls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseArgs(call.function.arguments) });
    const prompt = data.usage?.prompt_tokens ?? 0;
    const cached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      model: data.model || req.model,
      content,
      stopReason: choice.message.refusal ? 'refusal' : mapFinish(choice.finish_reason),
      // Cached prompt tokens are billed at the cache-read rate; the rest as input. No cache writes.
      usage: [{ model: data.model || req.model, inputTokens: prompt - cached, outputTokens: data.usage?.completion_tokens ?? 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: cached }],
      requestId: res.headers.get('x-request-id') ?? res.headers.get('apim-request-id') ?? data.id ?? null,
    };
  }

  async validateKey(creds: ProviderCredentials): Promise<KeyCheck> {
    try {
      await this.fetch(this.modelsEndpoint(creds), { method: 'GET', headers: this.headers(creds) });
      return { ok: true };
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError('unknown', (e as Error).message);
      return { ok: false, kind: err.kind, message: err.message };
    }
  }

  private async fetch(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 600_000);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (e) {
      if ((e as Error).name === 'AbortError' && signal?.aborted) throw e;
      throw new LlmError('connection', `Could not reach ${this.label}`);
    }
    if (res.ok) return res;
    // Error bodies never contain the key; keep only the provider's code.
    const err = (await res.json().catch(() => ({}))) as { error?: { code?: string; type?: string } };
    const code = err.error?.code ?? err.error?.type ?? '';
    throw new LlmError(errorKind(res.status, code), `${this.label} ${res.status} ${code}`.trim(), res.status);
  }
}

export class OpenAiProvider extends ChatCompletionsProvider {
  readonly id = 'openai' as const;
  protected label = 'OpenAI';
  private base = () => this.opts.baseURL ?? 'https://api.openai.com';
  protected endpoint = () => `${this.base()}/v1/chat/completions`;
  protected modelsEndpoint = () => `${this.base()}/v1/models`;
  protected headers = (creds: ProviderCredentials) => ({ authorization: `Bearer ${creds.apiKey}`, ...(creds.config.organization ? { 'openai-organization': creds.config.organization } : {}) });
}

/** Azure resource names: 2–64 letters, digits and hyphens. Only the name is accepted, never a URL. */
export const AZURE_RESOURCE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/i;
export const AZURE_API_VERSION = '2024-10-21';

export class AzureOpenAiProvider extends ChatCompletionsProvider {
  readonly id = 'azure_openai' as const;
  protected label = 'Azure OpenAI';
  private base(creds: ProviderCredentials) {
    if (this.opts.baseURL) return this.opts.baseURL;
    const resource = creds.config.resource ?? '';
    if (!AZURE_RESOURCE.test(resource)) throw new LlmError('bad_request', 'The Azure OpenAI key has no valid resource name');
    return `https://${resource}.openai.azure.com`;
  }
  private version = (creds: ProviderCredentials) => (/^\d{4}-\d{2}-\d{2}(-preview)?$/.test(creds.config.apiVersion ?? '') ? creds.config.apiVersion! : AZURE_API_VERSION);
  protected endpoint = (creds: ProviderCredentials, model: string) =>
    `${this.base(creds)}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${this.version(creds)}`;
  protected modelsEndpoint = (creds: ProviderCredentials) => `${this.base(creds)}/openai/models?api-version=${this.version(creds)}`;
  protected headers = (creds: ProviderCredentials) => ({ 'api-key': creds.apiKey });
}

function toChatMessages(req: LlmRequest): ChatMessage[] {
  const out: ChatMessage[] = [];
  const system = req.system.map((s) => s.text).join('\n\n');
  if (system) out.push({ role: 'system', content: system });
  for (const m of req.messages) out.push(...fromMessage(m));
  return out;
}

function fromMessage(m: Message): ChatMessage[] {
  const text = (blocks: ContentBlock[]) =>
    blocks
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  // Blocks from another provider (e.g. Anthropic thinking) can't be replayed here; they're dropped.
  if (m.role === 'assistant') {
    const calls = m.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    return [
      {
        role: 'assistant',
        content: text(m.content) || null,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {}),
      },
    ];
  }
  // Tool results become their own "tool" messages, before any text the user turn also carries.
  const results: ChatMessage[] = m.content
    .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
    .map((r) => ({ role: 'tool', tool_call_id: r.toolUseId, content: r.isError ? `Error: ${r.content}` : r.content }));
  const t = text(m.content);
  return t ? [...results, { role: 'user', content: t }] : results;
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    // The tool layer validates inputs against their schema, so a broken one is rejected there.
    return { _unparsed: raw };
  }
}

function mapFinish(r: string): StopReason {
  switch (r) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

function errorKind(status: number, code: string): LlmErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 429) return code === 'insufficient_quota' ? 'billing' : 'rate_limit';
  if (status === 402) return 'billing';
  if (status === 503 || status === 529) return 'overloaded';
  if (status >= 500) return 'server';
  if (status === 400 || status === 404 || status === 422) return 'bad_request';
  return 'unknown';
}
