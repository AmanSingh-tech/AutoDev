import { CryptoError, KEY_LEN, open, seal } from './aead';

/**
 * Wraps and unwraps data keys. Locally this is a master key from env. In production
 * an AWS KMS (or similar) implementation replaces it without touching callers.
 */
export interface KeyWrapper {
  /** Recorded next to each wrapped key so a later master key rotation knows which key unwraps it. */
  readonly keyId: string;
  wrap(dataKey: Buffer, context: string): Promise<Buffer>;
  unwrap(wrapped: Buffer, context: string): Promise<Buffer>;
}

export class LocalMasterKeyWrapper implements KeyWrapper {
  readonly keyId: string;
  readonly #masterKey: Buffer;

  constructor(masterKeyBase64: string, keyId: string) {
    const key = Buffer.from(masterKeyBase64, 'base64');
    if (key.length !== KEY_LEN) throw new CryptoError('MASTER_KEY must be 32 bytes');
    this.#masterKey = key;
    this.keyId = keyId;
  }

  async wrap(dataKey: Buffer, context: string): Promise<Buffer> {
    return seal(this.#masterKey, dataKey, `wrap:${this.keyId}:${context}`);
  }

  async unwrap(wrapped: Buffer, context: string): Promise<Buffer> {
    return open(this.#masterKey, wrapped, `wrap:${this.keyId}:${context}`);
  }
}

export function createKeyWrapper(env: {
  KMS_PROVIDER: 'local';
  MASTER_KEY: string;
  MASTER_KEY_ID: string;
}): KeyWrapper {
  switch (env.KMS_PROVIDER) {
    case 'local':
      return new LocalMasterKeyWrapper(env.MASTER_KEY, env.MASTER_KEY_ID);
  }
}
