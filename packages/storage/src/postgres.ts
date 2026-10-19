import { asc, eq, gt, schema, type SystemDb } from '@autodev/db';
import { compress, decompress, sha256, toBuffer, verified, type BlobStore } from './types';

const { blobs } = schema;
const PAGE = 500;

/**
 * Blobs in Postgres, gzipped on write. Rows written before content addressing (`encoding =
 * 'identity'`) are read as they are.
 */
export class PostgresBlobStore implements BlobStore {
  constructor(private readonly db: SystemDb) {}

  async put(body: Buffer | string) {
    const raw = toBuffer(body);
    const hash = sha256(raw);
    await this.db
      .insert(blobs)
      .values({ hash, size: raw.length, encoding: 'gzip', content: await compress(raw) })
      .onConflictDoNothing({ target: blobs.hash });
    return hash;
  }

  async get(hash: string) {
    const [row] = await this.db.select().from(blobs).where(eq(blobs.hash, hash));
    if (!row) return null;
    const raw = row.encoding === 'gzip' ? await decompress(row.content) : row.content;
    return verified(hash, raw);
  }

  async *list() {
    let after = '';
    for (;;) {
      const rows = await this.db
        .select({ hash: blobs.hash, createdAt: blobs.createdAt })
        .from(blobs)
        .where(gt(blobs.hash, after))
        .orderBy(asc(blobs.hash))
        .limit(PAGE);
      for (const r of rows) yield r;
      if (rows.length < PAGE) return;
      after = rows[rows.length - 1]!.hash;
    }
  }

  async delete(hash: string) {
    await this.db.delete(blobs).where(eq(blobs.hash, hash));
  }
}
