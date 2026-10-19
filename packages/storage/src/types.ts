import { createHash } from 'node:crypto';
import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Content-addressed blob storage. A blob is named by the sha256 of its bytes, so storing the same
 * bytes twice keeps one copy. Callers keep the returned hash in their own rows; nothing else is
 * shared between them. Deleting a blob is the caller's decision: check nothing still points at it.
 */
export interface BlobStore {
  /** Stores the bytes and returns their sha256 (hex). Storing existing bytes again is a no-op. */
  put(body: Buffer | string): Promise<string>;
  /** Returns the bytes, or null if there is no such blob. Throws if the stored bytes don't match the hash. */
  get(hash: string): Promise<Buffer | null>;
  /** Every stored blob, for migration and cleanup. */
  list(): AsyncIterable<{ hash: string; createdAt: Date }>;
  delete(hash: string): Promise<void>;
}

export class BlobIntegrityError extends Error {
  override name = 'BlobIntegrityError';
  constructor(readonly hash: string) {
    super(`Blob ${hash} does not match its hash`);
  }
}

export const toBuffer = (body: Buffer | string) =>
  Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const compress = (bytes: Buffer) => gzipAsync(bytes);
export const decompress = (bytes: Buffer) => gunzipAsync(bytes);

/** Checks the bytes against the hash they were fetched by. */
export function verified(hash: string, bytes: Buffer): Buffer {
  if (sha256(bytes) !== hash) throw new BlobIntegrityError(hash);
  return bytes;
}
