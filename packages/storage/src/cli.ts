/**
 * pnpm blobs:migrate --to s3|postgres
 * Copies every blob to the target driver from the other one, verifies each copy, and is safe to re-run.
 * Switching BLOB_DRIVER is a separate step: run this first, then change the setting.
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { loadEnv, dbEnv, storageEnv } from '@autodev/config';
import { copyBlobs } from './copy';
import { createBlobStore, systemDbFor } from './factory';
import { PostgresBlobStore } from './postgres';

// Same .env as the apps, so the command needs no extra setup.
config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const args = process.argv.slice(2);
const to = args[args.indexOf('--to') + 1];
if (to !== 'postgres' && to !== 's3') {
  console.error('usage: pnpm blobs:migrate --to s3|postgres');
  process.exit(2);
}

const env = loadEnv(dbEnv.merge(storageEnv));
const db = systemDbFor(env.DATABASE_URL_SYSTEM);
try {
  const pg = new PostgresBlobStore(db.db);
  const s3 = createBlobStore({ ...env, BLOB_DRIVER: 's3' }, db.db);
  const [from, target] = to === 's3' ? [pg, s3] : [s3, pg];
  console.log(`copying from ${to === 's3' ? 'postgres' : 's3'} to ${to}…`);
  const r = await copyBlobs(from, target, (p) => {
    if (p.scanned % 100 === 0) console.log(`  ${p.scanned} scanned, ${p.copied} copied`);
  });
  console.log(
    `done: ${r.scanned} scanned, ${r.copied} copied and verified, ${r.missing} missing at the source`,
  );
  if (r.missing > 0) process.exitCode = 1;
} finally {
  await db.close();
}
