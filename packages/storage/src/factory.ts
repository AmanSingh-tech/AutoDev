import { createSystemDb, type SystemDb } from '@autodev/db';
import type { z } from 'zod';
import { storageEnv } from '@autodev/config';
import { PostgresBlobStore } from './postgres';
import { S3BlobStore } from './s3';
import type { BlobStore } from './types';

export type StorageEnv = z.infer<typeof storageEnv>;

/** The driver chosen by BLOB_DRIVER. S3 needs its endpoint and keys, and fails early without them. */
export function createBlobStore(env: StorageEnv, db: SystemDb): BlobStore {
  if (env.BLOB_DRIVER === 'postgres') return new PostgresBlobStore(db);
  if (!env.S3_ENDPOINT || !env.S3_KEY || !env.S3_SECRET) {
    throw new Error('BLOB_DRIVER=s3 needs S3_ENDPOINT, S3_KEY and S3_SECRET');
  }
  return new S3BlobStore({
    endpoint: env.S3_ENDPOINT,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_KEY,
    secretAccessKey: env.S3_SECRET,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
}

/** Shared helper for apps: opens the system DB only when the driver needs it. */
export const systemDbFor = (url: string) => createSystemDb(url, 3);
