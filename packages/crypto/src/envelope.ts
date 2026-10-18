import { newDataKey, open, seal } from './aead';
import type { KeyWrapper } from './kms';

export interface WrappedDataKey {
  wrapped: Buffer;
  kmsKeyId: string;
}

/** Creates a fresh data key and returns only its wrapped form. The plaintext key is zeroed. */
export async function createWrappedDataKey(
  kms: KeyWrapper,
  context: string,
): Promise<WrappedDataKey> {
  const dk = newDataKey();
  try {
    return { wrapped: await kms.wrap(dk, context), kmsKeyId: kms.keyId };
  } finally {
    dk.fill(0);
  }
}

/**
 * Envelope encryption around one wrapped data key (per org, or per github_tokens row).
 * The data key is unwrapped for a single operation and zeroed straight after.
 */
export class Envelope {
  constructor(
    private readonly kms: KeyWrapper,
    private readonly wrappedKey: Buffer,
    /** Context the data key was wrapped with, e.g. "org:<uuid>". */
    private readonly keyContext: string,
  ) {}

  async encrypt(plaintext: string, aad: string): Promise<Buffer> {
    return this.withKey((dk) => seal(dk, Buffer.from(plaintext, 'utf8'), aad));
  }

  /** Decrypts, hands the secret to `fn`, then zeroes the plaintext buffer. Don't keep the value. */
  async useSecret<T>(blob: Buffer, aad: string, fn: (secret: string) => Promise<T> | T): Promise<T> {
    const plain = await this.withKey((dk) => open(dk, blob, aad));
    try {
      return await fn(plain.toString('utf8'));
    } finally {
      plain.fill(0);
    }
  }

  private async withKey<T>(fn: (dk: Buffer) => T): Promise<T> {
    const dk = await this.kms.unwrap(this.wrappedKey, this.keyContext);
    try {
      return fn(dk);
    } finally {
      dk.fill(0);
    }
  }
}

/** Last 4 characters for write-only UI display. */
export function last4(secret: string): string {
  return secret.slice(-4);
}
