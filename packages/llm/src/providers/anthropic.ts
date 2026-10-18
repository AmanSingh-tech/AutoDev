import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaToolUnion,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { LlmError, type LlmErrorKind } from '../errors';
import type {
  ContentBlock,
  KeyCheck,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  Message,
  ProviderCredentials,
  StopReason,
  UsageEntry,
} from '../types';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface AnthropicProviderOptions {
  /** Platform-level override, for tests only. Never taken from admin-supplied config (SSRF). */
  baseURL?: string;
  maxRetries?: number;
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  constructor(private readonly opts: AnthropicProviderOptions = {}) {}

  private client(creds: ProviderCredentials) {
    return new Anthropic({
      apiKey: creds.apiKey,
      baseURL: this.opts.baseURL,
      maxRetries: this.opts.maxRetries ?? 2,
    });
  }

  async complete(req: LlmRequest, creds: ProviderCredentials, opts: { signal?: AbortSignal } = {}): Promise<LlmResponse> {
    const client = this.client(creds);
    try {
      // Streaming, so large max_tokens values don't hit HTTP timeouts.
      // Thinking is omitted: current models run adaptive thinking by default.
      const stream = client.beta.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxOutputTokens,
          system: req.system.map(toSystemBlock),
          messages: req.messages.map(toMessageParam),
          ...(req.tools?.length ? { tools: req.tools.map(toTool) } : {}),
          ...(req.effort ? { output_config: { effort: req.effort } } : {}),
          ...(req.cacheConversation ? { cache_control: { type: 'ephemeral' as const } } : {}),
          ...(req.refusalFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
        },
        { signal: opts.signal },
      );
      const message = await stream.finalMessage();
      return {
        model: message.model,
        content: message.content.map(fromContentBlock),
        stopReason: mapStopReason(message.stop_reason),
        usage: usageEntries(message, req.model),
        requestId: stream.request_id ?? null,
      };
    } catch (e) {
      throw toLlmError(e);
    }
  }

  async validateKey(creds: ProviderCredentials): Promise<KeyCheck> {
    try {
      // Listing models authenticates the key without billing any tokens.
      await this.client(creds).models.list({ limit: 1 });
      return { ok: true };
    } catch (e) {
      const err = toLlmError(e);
      return { ok: false, kind: err.kind, message: err.message };
    }
  }
}

function toSystemBlock(b: LlmRequest['system'][number]): BetaTextBlockParam {
  return {
    type: 'text',
    text: b.text,
    ...(b.cache ? { cache_control: { type: 'ephemeral', ...(b.cache === '1h' ? { ttl: '1h' as const } : {}) } } : {}),
  };
}

function toMessageParam(m: Message): BetaMessageParam {
  return { role: m.role, content: m.content.map(toContentParam) };
}

function toContentParam(b: ContentBlock): BetaContentBlockParam {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, ...(b.isError ? { is_error: true } : {}) };
    case 'opaque':
      if (b.provider !== 'anthropic') throw new LlmError('bad_request', `Cannot replay a ${b.provider} block to Anthropic`);
      return b.block as BetaContentBlockParam;
  }
}

function toTool(t: NonNullable<LlmRequest['tools']>[number]): BetaToolUnion {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as BetaToolUnion extends { input_schema: infer S } ? S : never,
    ...(t.strict ? { strict: true } : {}),
    // Large tool inputs (file contents) stream as they're generated. The tool layer must validate
    // every parsed input against its schema, because a truncated input isn't rejected by the API.
    eager_input_streaming: true,
  } as BetaToolUnion;
}

function fromContentBlock(b: BetaContentBlock): ContentBlock {
  if (b.type === 'text') return { type: 'text', text: b.text };
  if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
  return { type: 'opaque', provider: 'anthropic', block: b };
}

function mapStopReason(r: BetaMessage['stop_reason']): StopReason {
  switch (r) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'pause';
    default:
      return 'other';
  }
}

type UsageLike = Pick<BetaUsage, 'input_tokens' | 'output_tokens' | 'cache_creation' | 'cache_read_input_tokens'> & {
  cache_creation_input_tokens: number | null;
};

function entry(model: string, u: UsageLike): UsageEntry {
  const write5m = u.cache_creation?.ephemeral_5m_input_tokens;
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    model,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    // Without the TTL breakdown, every cache write is billed at the 5-minute rate.
    cacheWrite5mTokens: write5m ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - write1h),
    cacheWrite1hTokens: write1h,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
}

/**
 * With server-side fallback (or server tool loops), usage.iterations lists every sampling pass
 * with its model, and those entries are what's billed. Otherwise the top-level usage applies.
 */
export function usageEntries(message: Pick<BetaMessage, 'usage' | 'model'>, requestedModel: string): UsageEntry[] {
  const iterations = message.usage.iterations ?? [];
  const billable = iterations.filter(
    (i): i is Extract<(typeof iterations)[number], { type: 'message' | 'fallback_message' }> =>
      i.type === 'message' || i.type === 'fallback_message',
  );
  if (!billable.length) return [entry(message.model, message.usage)];

  const byModel = new Map<string, UsageEntry>();
  for (const it of billable) {
    const e = entry(it.model ?? requestedModel, it);
    const acc = byModel.get(e.model);
    if (!acc) byModel.set(e.model, e);
    else {
      acc.inputTokens += e.inputTokens;
      acc.outputTokens += e.outputTokens;
      acc.cacheWrite5mTokens += e.cacheWrite5mTokens;
      acc.cacheWrite1hTokens += e.cacheWrite1hTokens;
      acc.cacheReadTokens += e.cacheReadTokens;
    }
  }
  return [...byModel.values()];
}

/** Maps SDK errors to kinds, most specific first. The SDK never puts the API key in messages. */
export function toLlmError(e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  if (e instanceof Anthropic.APIConnectionError) return new LlmError('connection', 'Could not reach Anthropic');
  if (e instanceof Anthropic.APIError) {
    const type = (e as { type?: string | null }).type;
    const kind: LlmErrorKind =
      e instanceof Anthropic.AuthenticationError
        ? 'auth'
        : e instanceof Anthropic.PermissionDeniedError
          ? 'permission'
          : e.status === 402 || type === 'billing_error'
            ? 'billing'
            : e instanceof Anthropic.RateLimitError
              ? 'rate_limit'
              : e.status === 529 || type === 'overloaded_error'
                ? 'overloaded'
                : e instanceof Anthropic.InternalServerError
                  ? 'server'
                  : e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError
                    ? 'bad_request'
                    : 'unknown';
    return new LlmError(kind, `Anthropic ${e.status ?? ''} ${type ?? ''}`.replace(/\s+/g, ' ').trim(), e.status);
  }
  return new LlmError('unknown', e instanceof Error ? e.message : 'Unknown LLM error');
}
