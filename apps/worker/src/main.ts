import { AgentOrchestrator, PgBlobStore } from '@autodev/agent';
import { agentJob, coreEnv, cryptoEnv, dbEnv, githubEnv, llmEnv, loadEnv, QUEUES, redisEnv } from '@autodev/config';
import { createKeyWrapper } from '@autodev/crypto';
import { createAppDb, createSystemDb } from '@autodev/db';
import { githubConfigFromEnv, TokenVault, type KvCache } from '@autodev/github';
import { createProviderRegistry, CredentialService, LlmGateway } from '@autodev/llm';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { createKeyValidationProcessor } from './key-validation';
import { createMaintenanceProcessor } from './maintenance';
import { createRepoSyncProcessor } from './repo-sync';

const env = loadEnv(coreEnv.merge(dbEnv).merge(redisEnv).merge(githubEnv).merge(cryptoEnv).merge(llmEnv));
const log = pino({ level: env.LOG_LEVEL });
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const sys = createSystemDb(env.DATABASE_URL_SYSTEM);
const app = createAppDb(env.DATABASE_URL, 2);
const cfg = githubConfigFromEnv(env);
const providers = createProviderRegistry({ anthropic: { baseURL: env.ANTHROPIC_BASE_URL } });
const kms = createKeyWrapper(env);
const credentials = new CredentialService({ app: app.db, sys: sys.db, kms, providers });
const cache: KvCache = {
  get: (k) => connection.get(k),
  set: async (k, v, ttl) => void (await connection.set(k, v, 'EX', ttl)),
  setIfAbsent: async (k, v, ttl) => (await connection.set(k, v, 'EX', ttl, 'NX')) === 'OK',
  del: async (k) => void (await connection.del(k)),
  incr: (k) => connection.incr(k),
};
const orchestrator = new AgentOrchestrator({
  sys: sys.db,
  gateway: new LlmGateway({ sys: sys.db, providers, credentials }),
  vault: new TokenVault(sys.db, kms, cfg),
  cfg,
  cache,
  blobs: new PgBlobStore(sys.db),
});

// Daily schedules (UTC). upsertJobScheduler is idempotent across restarts and replicas.
const keyValidation = new Queue(QUEUES.keyValidation, { connection });
const maintenance = new Queue(QUEUES.maintenance, { connection });
await keyValidation.upsertJobScheduler('daily-key-validation', { pattern: '0 3 * * *', tz: 'UTC' }, { name: 'revalidate-all' });
await maintenance.upsertJobScheduler('daily-partitions', { pattern: '0 1 * * *', tz: 'UTC' }, { name: 'partitions' });
await maintenance.add('partitions', {}, { jobId: `partitions-boot-${new Date().toISOString().slice(0, 10)}`, removeOnComplete: true });

// The stale-branch worker arrives in A-6.
const agentWorker = new Worker(QUEUES.agent, (job) => orchestrator.process(agentJob.parse(job.data)), {
  connection,
  concurrency: 4,
  // Agent turns can take minutes; the orchestrator refreshes its own task lock.
  lockDuration: 10 * 60_000,
});
agentWorker.on('failed', async (job, err) => {
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    const data = agentJob.safeParse(job.data);
    if (data.success) await orchestrator.failTask(data.data.orgId, data.data.taskId, `The agent kept failing: ${err.message}`).catch((e) => log.error({ err: e }, 'failTask'));
  }
});

const workers = [
  agentWorker,
  new Worker(QUEUES.repoSync, createRepoSyncProcessor({ sys: sys.db, cfg }), { connection, concurrency: 5 }),
  new Worker(QUEUES.keyValidation, createKeyValidationProcessor(credentials), { connection, concurrency: 1 }),
  new Worker(QUEUES.maintenance, createMaintenanceProcessor(sys.db), { connection, concurrency: 1 }),
];

for (const w of workers) {
  w.on('completed', (job, result) => log.info({ queue: w.name, jobId: job.id, result }, 'job completed'));
  w.on('failed', (job, err) => log.error({ queue: w.name, jobId: job?.id, err: err.message }, 'job failed'));
}
log.info({ queues: workers.map((w) => w.name) }, 'worker started');

const shutdown = async () => {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all([keyValidation.close(), maintenance.close()]);
  await Promise.all([sys.close(), app.close()]);
  connection.disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
