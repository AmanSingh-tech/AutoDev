import { eq, schema, type SystemDb } from '@autodev/db';

/** Object storage for transcripts and large outputs. Postgres now; an S3 implementation drops in later. */
export interface BlobStore {
  put(orgId: string, key: string, body: Buffer | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

export class PgBlobStore implements BlobStore {
  constructor(private readonly sys: SystemDb) {}

  async put(orgId: string, key: string, body: Buffer | string, contentType = 'application/octet-stream') {
    const content = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    await this.sys
      .insert(schema.blobs)
      .values({ key, orgId, content, contentType, size: content.length })
      .onConflictDoUpdate({ target: schema.blobs.key, set: { content, contentType, size: content.length } });
  }

  async get(key: string) {
    const [row] = await this.sys.select({ content: schema.blobs.content }).from(schema.blobs).where(eq(schema.blobs.key, key));
    return row?.content ?? null;
  }
}

export class MemoryBlobStore implements BlobStore {
  readonly data = new Map<string, Buffer>();
  async put(_orgId: string, key: string, body: Buffer | string) {
    this.data.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body));
  }
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
}
