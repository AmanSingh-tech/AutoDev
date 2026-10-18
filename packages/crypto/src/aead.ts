import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const FORMAT_V1 = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;
export const KEY_LEN = 32;

/**
 * AES-256-GCM. Layout: [format:1][nonce:12][ciphertext][tag:16].
 * `aad` binds the ciphertext to its owner (e.g. "llm_credentials:<id>"), so a blob
 * copied into another row fails to decrypt.
 */
export function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  assertKey(key);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_V1]), nonce, ct, cipher.getAuthTag()]);
}

export function open(key: Buffer, blob: Buffer, aad: string): Buffer {
  assertKey(key);
  if (blob.length < 1 + NONCE_LEN + TAG_LEN || blob[0] !== FORMAT_V1) {
    throw new CryptoError('unsupported ciphertext format');
  }
  const nonce = blob.subarray(1, 1 + NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(1 + NONCE_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // Never surface the underlying error: it can hint at which part was wrong.
    throw new CryptoError('decryption failed');
  }
}

export function newDataKey(): Buffer {
  return randomBytes(KEY_LEN);
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_LEN) throw new CryptoError('key must be 32 bytes');
}

export class CryptoError extends Error {
  override name = 'CryptoError';
}
