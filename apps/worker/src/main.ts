import { AgentOrchestrator, BuilderJobs, Publisher, publishBus, RepoAgent, RepoChatRunner } from '@autodev/agent';
import { emit } from '@autodev/events';
import { ORG_ADMIN_TOPIC } from '@autodev/protocol';
import { createBlobStore } from '@autodev/storage';
import { CodeIndexer, FakeEmbedder, githubSource, IndexedCodeSearch, LocalEmbedder, type Embedder } from '@autodev/code-index';
import { agentJob, chatJob, codeIndexEnv, coreEnv, cryptoEnv, dbEnv, githubEnv, groupAgentEnv, groupAgentJob, llmEnv, loadEnv, QUEUES, redisEnv, storageEnv, type CodeIndexJob, type GroupAgentJob } from '@autodev/config';
import { createKeyWrapper } from '@autodev/crypto';
import { createAppDb, createSystemDb } from '@autodev/db';
import { githubConfigFromEnv, TokenVault, type KvCache } from '@autodev/github';
import { createProviderRegistry, CredentialService, LlmGateway } from '@autodev/llm';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { createCodeIndexProcessor } from './code-index';
import { createGroupAgentProcessor } from './group-agent/processor';
import { createKeyValidationProcessor } from './key-validation';
import { createMaintenanceProcessor } from './maintenance';
import { createRepoSyncProcessor } from './repo-sync';
import { sweepStaleBranches } from './stale-branch';

const env = loadEnv(coreEnv.merge(dbEnv).merge(redisEnv).merge(githubEnv).merge(cryptoEnv).merge(llmEnv).merge(storageEnv).merge(codeIndexEnv).merge(groupAgentEnv));
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
const blobs = createBlobStore(env, sys.db);
const agentQueue = new Queue(QUEUES.agent, { connection, defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000, attempts: 4, backoff: { type: 'exponential', delay: 15_000 } } });
const builderJobs = new BuilderJobs({
  sys: sys.db,
  cache,
  blobs,
  bus: publishBus((c, m) => connection.publish(c, m)),
  enqueueAgent: (data, jobId) => agentQueue.add('run', data, { jobId }),
});
const vault = new TokenVault(sys.db, kms, cfg);
const gateway = new LlmGateway({ sys: sys.db, providers, credentials });
const publisher = new Publisher({ sys: sys.db, vault, cfg, cache, webUrl: env.WEB_URL });
// One model instance per worker process, shared by indexing and chat searches.
if (env.EMBEDDINGS_PROVIDER === 'fake' && env.NODE_ENV === 'production') throw new Error('EMBEDDINGS_PROVIDER=fake is for tests only');
const embedder: Embedder =
  env.EMBEDDINGS_PROVIDER === 'fake' ? new FakeEmbedder() : new LocalEmbedder({ ...(env.EMBEDDINGS_CACHE_DIR ? { cacheDir: env.EMBEDDINGS_CACHE_DIR } : {}) });
const indexer = new CodeIndexer({ sys: sys.db, embedder, sourceFor: (repo) => githubSource(cfg, repo) });
const codeSearch = new IndexedCodeSearch({ sys: sys.db, embedder });
// Finished and failed jobs are removed so their per-repo job id frees up; failures are kept in code_index_state.
const codeIndexQueue = new Queue<CodeIndexJob>(QUEUES.codeIndex, { connection, defaultJobOptions: { removeOnComplete: true, removeOnFail: true, attempts: 3, backoff: { type: 'exponential', delay: 60_000 } } });
const repoChat = new RepoChatRunner({ sys: sys.db, gateway, vault, cfg, cache, codeSearch });
const repoAgent = new RepoAgent({ sys: sys.db, gateway, vault, cfg, cache, codeSearch });
const orchestrator = new AgentOrchestrator({
  sys: sys.db,
  gateway,
  vault,
  cfg,
  cache,
  blobs,
  builderJobs,
  publisher,
});

// Daily schedules (UTC). upsertJobScheduler is idempotent across restarts and replicas.
const keyValidation = new Queue(QUEUES.keyValidation, { connection });
const maintenance = new Queue(QUEUES.maintenance, { connection });
const staleBranch = new Queue(QUEUES.staleBranch, { connection });
await keyValidation.upsertJobScheduler('daily-key-validation', { pattern: '0 3 * * *', tz: 'UTC' }, { name: 'revalidate-all' });
await staleBranch.upsertJobScheduler('nightly-stale-branches', { pattern: '0 2 * * *', tz: 'UTC' }, { name: 'sweep' });
await maintenance.upsertJobScheduler('daily-partitions', { pattern: '0 1 * * *', tz: 'UTC' }, { name: 'partitions' });
await maintenance.upsertJobScheduler('daily-blob-retention', { pattern: '0 4 * * *', tz: 'UTC' }, { name: 'blob-retention' });
const groupAgent = createGroupAgentProcessor({ sys: sys.db, urls: env, cfg });
const groupAgentQueue = new Queue<GroupAgentJob>(QUEUES.groupAgent, { connection, defaultJobOptions: { removeOnComplete: true, removeOnFail: 500 } });
await groupAgentQueue.upsertJobScheduler('nightly-group-agent-scan', { pattern: '30 3 * * *', tz: 'UTC' }, { name: 'scan', data: { kind: 'scan' } });
await groupAgentQueue.upsertJobScheduler('weekly-group-agent-digest', { pattern: '0 8 * * 1', tz: 'UTC' }, { name: 'digest', data: { kind: 'digest' } });
await maintenance.upsertJobScheduler('nightly-insights', { pattern: '30 0 * * *', tz: 'UTC' }, { name: 'insights' });
await codeIndexQueue.upsertJobScheduler('nightly-code-index', { pattern: '0 5 * * *', tz: 'UTC' }, { name: 'nightly', data: { kind: 'nightly' } });
await maintenance.add('partitions', {}, { jobId: `partitions-boot-${new Date().toISOString().slice(0, 10)}`, removeOnComplete: true });

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
  new Worker(
    QUEUES.repoSync,
    createRepoSyncProcessor({ sys: sys.db, cfg, onSynced: (orgId) => codeIndexQueue.add('org', { kind: 'org', orgId }, { jobId: `org-${orgId}` }) }),
    { connection, concurrency: 5 },
  ),
  // Embedding is CPU-bound and the model runs one batch at a time, so two repos at once is plenty.
  new Worker(QUEUES.codeIndex, createCodeIndexProcessor({ indexer, queue: codeIndexQueue }), { connection, concurrency: 2, lockDuration: 10 * 60_000 }),
  new Worker(QUEUES.keyValidation, createKeyValidationProcessor(credentials), { connection, concurrency: 1 }),
  new Worker(QUEUES.maintenance, createMaintenanceProcessor({ sys: sys.db, blobs }), { connection, concurrency: 1 }),
  // Scans read every repo's lockfiles and call OSV and the registries; one org at a time.
  new Worker(QUEUES.groupAgent, (job) => groupAgent({ data: groupAgentJob.parse(job.data) }), { connection, concurrency: 1, lockDuration: 10 * 60_000 }),
  new Worker(
    QUEUES.staleBranch,
    () =>
      sweepStaleBranches({
        sys: sys.db,
        publisher,
        onStale: async (b) => {
          await emit(connection, { type: 'stale_branch.found', orgId: b.orgId, topic: ORG_ADMIN_TOPIC, payload: { taskId: b.taskId, repoId: b.repoId, days: b.days } });
        },
      }),
    { connection, concurrency: 1 },
  ),
  // Chat answers read several files, so they can take a minute or two.
  new Worker(QUEUES.chat, (job) => {
    const data = chatJob.parse(job.data);
    return data.kind === 'room' ? repoAgent.answerInRoom(data.orgId, data.messageId) : repoChat.answer(data.orgId, data.messageId);
  }, { connection, concurrency: 4, lockDuration: 5 * 60_000 }),
];

for (const w of workers) {
  w.on('completed', (job, result) => log.info({ queue: w.name, jobId: job.id, result }, 'job completed'));
  w.on('failed', (job, err) => log.error({ queue: w.name, jobId: job?.id, err: err.message }, 'job failed'));
}
log.info({ queues: workers.map((w) => w.name) }, 'worker started');

const shutdown = async () => {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all([keyValidation.close(), maintenance.close(), staleBranch.close(), agentQueue.close(), codeIndexQueue.close()]);
  await Promise.all([sys.close(), app.close()]);
  connection.disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
