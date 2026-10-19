import { compress, decompress, sha256, toBuffer, verified, type BlobStore } from './types';

/** In-process store for tests. Keeps the same contract as the real drivers. */
export class MemoryBlobStore implements BlobStore {
  readonly data = new Map<string, { content: Buffer; createdAt: Date }>();

  async put(body: Buffer | string) {
    const raw = toBuffer(body);
    const hash = sha256(raw);
    if (!this.data.has(hash))
      this.data.set(hash, { content: await compress(raw), createdAt: new Date() });
    return hash;
  }

  async get(hash: string) {
    const row = this.data.get(hash);
    if (!row) return null;
    return verified(hash, await decompress(row.content));
  }

  async *list() {
    for (const [hash, row] of this.data) yield { hash, createdAt: row.createdAt };
  }

  async delete(hash: string) {
    this.data.delete(hash);
  }
}
