import type { BetaContentBlock, BetaContentBlockParam, BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { LlmError, type LlmErrorKind } from '../errors';
import type { ContentBlock, KeyCheck, LlmProvider, LlmRequest, LlmResponse, Message, ProviderCredentials } from '../types';
import { fromContentBlock, mapStopReason, toContentParam, toSystemBlock, usageEntries } from './anthropic';

/**
 * Claude on Amazon Bedrock (B-7), with a Bedrock API key (a bearer token, so no AWS SigV4 or SDK).
 * Bedrock's InvokeModel takes and returns Anthropic's Messages format, so the Anthropic mapping is
 * reused. The model is the Bedrock model or inference-profile id (e.g. us.anthropic.claude-…).
 */
export interface BedrockProviderOptions {
  /** Platform-level override, for tests only. Never taken from admin-supplied config (SSRF). */
  baseURL?: string;
  timeoutMs?: number;
}

/** AWS region names (us-east-1, eu-central-2, us-gov-west-1, ap-southeast-4…). */
export const AWS_REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d{1,2}$/;

export class BedrockProvider implements LlmProvider {
  readonly id = 'bedrock' as const;
  constructor(private readonly opts: BedrockProviderOptions = {}) {}

  private region(creds: ProviderCredentials) {
    const region = creds.config.region ?? '';
    if (!AWS_REGION.test(region)) throw new LlmError('bad_request', 'The Bedrock key has no valid AWS region');
    return region;
  }
  private runtime = (creds: ProviderCredentials) => this.opts.baseURL ?? `https://bedrock-runtime.${this.region(creds)}.amazonaws.com`;
  private control = (creds: ProviderCredentials) => this.opts.baseURL ?? `https://bedrock.${this.region(creds)}.amazonaws.com`;

  async complete(req: LlmRequest, creds: ProviderCredentials, opts: { signal?: AbortSignal } = {}): Promise<LlmResponse> {
    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: req.maxOutputTokens,
      system: req.system.map(toSystemBlock),
      messages: req.messages.map(toBedrockMessage),
      ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
    };
    const res = await this.fetch(`${this.runtime(creds)}/model/${encodeURIComponent(req.model)}/invoke`, creds, { method: 'POST', body: JSON.stringify(body) }, opts.signal);
    const message = (await res.json()) as BetaMessage;
    return {
      model: message.model ?? req.model,
      content: message.content.map((b: BetaContentBlock) => tagBedrock(fromContentBlock(b))),
      stopReason: mapStopReason(message.stop_reason),
      usage: usageEntries({ usage: message.usage, model: message.model ?? req.model }, req.model).map((u) => ({ ...u, model: req.model })),
      requestId: res.headers.get('x-amzn-requestid'),
    };
  }

  async validateKey(creds: ProviderCredentials): Promise<KeyCheck> {
    try {
      await this.fetch(`${this.control(creds)}/foundation-models?byProvider=Anthropic`, creds, { method: 'GET' });
      return { ok: true };
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError('unknown', (e as Error).message);
      return { ok: false, kind: err.kind, message: err.message };
    }
  }

  private async fetch(url: string, creds: ProviderCredentials, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 600_000);
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { authorization: `Bearer ${creds.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError' && signal?.aborted) throw e;
      throw new LlmError('connection', 'Could not reach Amazon Bedrock');
    }
    if (res.ok) return res;
    const type = (res.headers.get('x-amzn-errortype') ?? '').split(':')[0] || ((await res.json().catch(() => ({}))) as { __type?: string }).__type?.split('#').pop() || '';
    throw new LlmError(errorKind(res.status, type), `Bedrock ${res.status} ${type}`.trim(), res.status);
  }
}

/** Opaque blocks Bedrock returned are Anthropic blocks; mark them so they replay to Bedrock only. */
function tagBedrock(b: ContentBlock): ContentBlock {
  return b.type === 'opaque' ? { ...b, provider: 'bedrock' } : b;
}

function toBedrockMessage(m: Message): { role: Message['role']; content: BetaContentBlockParam[] } {
  return {
    role: m.role,
    content: m.content.map((b) => (b.type === 'opaque' && (b.provider === 'bedrock' || b.provider === 'anthropic') ? (b.block as BetaContentBlockParam) : toContentParam(b))),
  };
}

function errorKind(status: number, type: string): LlmErrorKind {
  if (type === 'UnrecognizedClientException' || type === 'ExpiredTokenException' || status === 401) return 'auth';
  if (type === 'AccessDeniedException' || status === 403) return 'permission';
  if (type === 'ThrottlingException' || type === 'ServiceQuotaExceededException' || status === 429) return 'rate_limit';
  if (type === 'ServiceUnavailableException' || status === 503) return 'overloaded';
  if (type === 'ValidationException' || type === 'ResourceNotFoundException' || status === 400 || status === 404) return 'bad_request';
  if (status >= 500 || status === 424) return 'server';
  return 'unknown';
}
