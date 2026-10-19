import { schema, createSystemDb, eq } from '@autodev/db';
import { TEST_SYSTEM_URL } from '@autodev/db/testing';
import S3rver from 's3rver';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { copyBlobs } from './copy';
import { createBlobStore } from './factory';
import { MemoryBlobStore } from './memory';
import { PostgresBlobStore } from './postgres';
import { S3BlobStore } from './s3';
import { BlobIntegrityError, compress, sha256, type BlobStore } from './types';

const sys = createSystemDb(TEST_SYSTEM_URL);
const S3_PORT = 4777;
// s3rver accepts only its built-in credentials.
const S3_OPTS = {
  endpoint: `http://127.0.0.1:${S3_PORT}`,
  bucket: 'autodev-test',
  accessKeyId: 'S3RVER',
  secretAccessKey: 'S3RVER',
};

// s3rver stands in for an S3-compatible server here; CI runs the same suite against MinIO.
const s3 = new S3rver({
  port: S3_PORT,
  address: '127.0.0.1',
  silent: true,
  configureBuckets: [{ name: S3_OPTS.bucket, configs: [] }],
});

beforeAll(async () => {
  await s3.run();
});
afterAll(async () => {
  await s3.close();
  await sys.close();
});
beforeEach(async () => {
  await sys.db.delete(schema.blobs);
});

/** Each driver corrupts its own stored bytes, so the integrity check can be tested for real. */
const drivers: {
  name: string;
  make: () => BlobStore;
  corrupt: (store: BlobStore, hash: string) => Promise<void>;
}[] = [
  {
    name: 'postgres',
    make: () => new PostgresBlobStore(sys.db),
    corrupt: async (_store, hash) => {
      await sys.db
        .update(schema.blobs)
        .set({ content: await compress(Buffer.from('tampered')) })
        .where(eq(schema.blobs.hash, hash));
    },
  },
  {
    name: 'memory',
    make: () => new MemoryBlobStore(),
    corrupt: async (store, hash) => {
      (store as MemoryBlobStore).data.set(hash, {
        content: await compress(Buffer.from('tampered')),
        createdAt: new Date(),
      });
    },
  },
  {
    name: 's3',
    make: () => new S3BlobStore(S3_OPTS),
    corrupt: async (_store, hash) => {
      const client = new S3Client({
        endpoint: S3_OPTS.endpoint,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: { accessKeyId: S3_OPTS.accessKeyId, secretAccessKey: S3_OPTS.secretAccessKey },
        requestChecksumCalculation: 'WHEN_REQUIRED',
      });
      await client.send(
        new PutObjectCommand({
          Bucket: S3_OPTS.bucket,
          Key: `blobs/${hash.slice(0, 2)}/${hash}`,
          Body: await compress(Buffer.from('tampered')),
          ContentEncoding: 'gzip',
        }),
      );
    },
  },
];

for (const d of drivers) {
  describe(`BlobStore (${d.name})`, () => {
    it('names a blob by the sha256 of its bytes and reads it back', async () => {
      const store = d.make();
      const hash = await store.put('hello world\n');
      expect(hash).toBe(sha256(Buffer.from('hello world\n')));
      expect((await store.get(hash))!.toString('utf8')).toBe('hello world\n');
    });

    it('keeps one copy of identical bytes', async () => {
      const store = d.make();
      const a = await store.put('same');
      const b = await store.put(Buffer.from('same'));
      expect(a).toBe(b);
      const hashes = [];
      for await (const { hash } of store.list()) hashes.push(hash);
      expect(hashes.filter((h) => h === a)).toHaveLength(1);
    });

    it('returns null for an unknown hash', async () => {
      expect(await d.make().get('0'.repeat(64))).toBeNull();
    });

    it('refuses bytes that no longer match their hash', async () => {
      const store = d.make();
      const hash = await store.put('original');
      await d.corrupt(store, hash);
      await expect(store.get(hash)).rejects.toBeInstanceOf(BlobIntegrityError);
    });

    it('deletes a blob', async () => {
      const store = d.make();
      const hash = await store.put('gone soon');
      await store.delete(hash);
      expect(await store.get(hash)).toBeNull();
    });
  });
}

describe('copyBlobs', () => {
  it('copies every blob, verifies each one, and is safe to run twice', async () => {
    const from = new MemoryBlobStore();
    const h1 = await from.put('one');
    const h2 = await from.put('two');
    const to = new PostgresBlobStore(sys.db);

    const first = await copyBlobs(from, to);
    expect(first).toEqual({ scanned: 2, copied: 2, missing: 0 });
    expect((await to.get(h1))!.toString()).toBe('one');
    expect((await to.get(h2))!.toString()).toBe('two');

    const second = await copyBlobs(from, to);
    expect(second.copied).toBe(2);
    const count = await sys.db.select().from(schema.blobs);
    expect(count).toHaveLength(2);
  });
});

describe('createBlobStore', () => {
  const base = {
    BLOB_DRIVER: 'postgres',
    S3_BUCKET: 'autodev',
    S3_REGION: 'us-east-1',
    S3_FORCE_PATH_STYLE: true,
  } as const;

  it('picks Postgres by default', () => {
    expect(createBlobStore({ ...base, BLOB_DRIVER: 'postgres' } as never, sys.db)).toBeInstanceOf(
      PostgresBlobStore,
    );
  });

  it('refuses the S3 driver without its settings, instead of failing later', () => {
    expect(() => createBlobStore({ ...base, BLOB_DRIVER: 's3' } as never, sys.db)).toThrow(
      /S3_ENDPOINT, S3_KEY and S3_SECRET/,
    );
  });
});
