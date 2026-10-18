import { coreEnv, dbEnv, githubEnv, loadEnv, QUEUES, redisEnv } from '@autodev/config';
import { createSystemDb } from '@autodev/db';
import { githubConfigFromEnv } from '@autodev/github';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { createRepoSyncProcessor } from './repo-sync';

const env = loadEnv(coreEnv.merge(dbEnv).merge(redisEnv).merge(githubEnv));
const log = pino({ level: env.LOG_LEVEL });
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const sys = createSystemDb(env.DATABASE_URL_SYSTEM);
const cfg = githubConfigFromEnv(env);

// Section A adds agent, stale-branch and key-validation workers here in later phases.
const workers = [
  new Worker(QUEUES.repoSync, createRepoSyncProcessor({ sys: sys.db, cfg }), { connection, concurrency: 5 }),
];

for (const w of workers) {
  w.on('completed', (job, result) => log.info({ queue: w.name, jobId: job.id, result }, 'job completed'));
  w.on('failed', (job, err) => log.error({ queue: w.name, jobId: job?.id, err: err.message }, 'job failed'));
}
log.info({ queues: workers.map((w) => w.name) }, 'worker started');

const shutdown = async () => {
  await Promise.all(workers.map((w) => w.close()));
  await sys.close();
  connection.disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
