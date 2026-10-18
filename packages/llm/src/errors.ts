export type LlmErrorKind =
  | 'auth' // key rejected
  | 'permission' // key valid but not allowed (model, workspace)
  | 'billing' // provider account out of credit
  | 'rate_limit'
  | 'overloaded'
  | 'server'
  | 'connection'
  | 'bad_request'
  | 'unknown';

/** These mean the key itself is unusable: the task pauses as blocked_on_key and admins are told. */
export const KEY_FAILURE_KINDS: readonly LlmErrorKind[] = ['auth', 'permission', 'billing'];

/** Provider errors normalized. `message` is safe to log and show: it never contains the key. */
export class LlmError extends Error {
  override name = 'LlmError';
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
  get isKeyFailure() {
    return KEY_FAILURE_KINDS.includes(this.kind);
  }
  get retryable() {
    return ['rate_limit', 'overloaded', 'server', 'connection'].includes(this.kind);
  }
}

/** The gateway refuses a call before it reaches the provider. */
export class LlmBlocked extends Error {
  override name = 'LlmBlocked';
  constructor(
    readonly reason: 'no_credential' | 'budget_exceeded' | 'task_token_cap' | 'provider_unsupported',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** A key failed during a call. It's now marked invalid; callers move the task to blocked_on_key. */
export class KeyFailure extends Error {
  override name = 'KeyFailure';
  constructor(
    readonly credentialId: string,
    readonly error: LlmError,
  ) {
    super(`LLM key failed: ${error.message}`);
  }
}
