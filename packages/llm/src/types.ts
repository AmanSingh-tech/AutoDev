import type { LlmProviderId } from '@autodev/db';

export type ProviderId = LlmProviderId;
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Provider-neutral content. `opaque` carries provider blocks we don't interpret (thinking,
 * fallback markers…). The agent must echo them back verbatim on the next turn: some models
 * reject edited history.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'opaque'; provider: ProviderId; block: unknown };

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

/** System prompt segment. `cache` marks a prompt-caching breakpoint at the end of this block. */
export interface SystemBlock {
  text: string;
  cache?: '5m' | '1h';
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  strict?: boolean;
}

export interface LlmRequest {
  model: string;
  system: SystemBlock[];
  messages: Message[];
  tools?: ToolDef[];
  maxOutputTokens: number;
  effort?: Effort;
  /** Also cache the growing conversation tail (automatic caching). */
  cacheConversation?: boolean;
  /** Let the provider re-run a refused request on a fallback model, when it supports that. */
  refusalFallback?: boolean;
}

/** Usage for one model. A fallback-served call yields one entry per model that ran. */
export interface UsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause' | 'other';

export interface LlmResponse {
  /** The model that produced the final content (differs from the request after a fallback). */
  model: string;
  content: ContentBlock[];
  stopReason: StopReason;
  usage: UsageEntry[];
  requestId: string | null;
}

export interface ProviderCredentials {
  apiKey: string;
  /** Non-secret, admin-supplied settings (e.g. Azure deployment, AWS region). */
  config: Record<string, string>;
}

export type KeyCheck = { ok: true } | { ok: false; kind: import('./errors').LlmErrorKind; message: string };

export interface LlmProvider {
  readonly id: ProviderId;
  complete(req: LlmRequest, creds: ProviderCredentials, opts?: { signal?: AbortSignal }): Promise<LlmResponse>;
  /** Cheapest call that proves the key works (no tokens billed where the provider allows). */
  validateKey(creds: ProviderCredentials): Promise<KeyCheck>;
}
