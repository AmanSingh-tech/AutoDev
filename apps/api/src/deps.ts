import { QUEUES, type AgentJob, type JobQueue, type RepoSyncJob } from '@autodev/config';
import { createKeyWrapper, type KeyWrapper } from '@autodev/crypto';
import { createAppDb, createSystemDb, type AppDb, type SystemDb } from '@autodev/db';
import {
  githubConfigFromEnv,
  RepoAccessService,
  TokenVault,
  type GitHubConfig,
  type KvCache,
} from '@autodev/github';
import { BuilderJobs, liveLogsKey, PgBlobStore, Publisher, publishBus, type BlobStore } from '@autodev/agent';
import { createProviderRegistry, CredentialService, LlmGateway, type ProviderRegistry } from '@autodev/llm';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { ApiEnv } from './env';
import { redisCache } from './redis-cache';

export interface Deps {
  env: Pick<ApiEnv, 'WEB_URL' | 'AUTH_SECRET' | 'NODE_ENV' | 'BUILDER_GATEWAY_URL'>;
  app: AppDb;
  sys: SystemDb;
  kms: KeyWrapper;
  cfg: GitHubConfig;
  vault: TokenVault;
  cache: KvCache;
  repoAccess: RepoAccessService;
  queues: { repoSync: JobQueue<RepoSyncJob>; agent: JobQueue<AgentJob> };
  providers: ProviderRegistry;
  credentials: CredentialService;
  gateway: LlmGateway;
  blobs: BlobStore;
  builderJobs: BuilderJobs;
  publisher: Publisher;
  /** Log lines streamed so far for a running builder job (Redis). */
  liveLogs: (jobId: string) => Promise<string>;
}

export function createDeps(env: ApiEnv): Deps & { close: () => Promise<void> } {
  const app = createAppDb(env.DATABASE_URL);
  const sys = createSystemDb(env.DATABASE_URL_SYSTEM);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const kms = createKeyWrapper(env);
  const cfg = githubConfigFromEnv(env);
  const cache = redisCache(redis);
  const vault = new TokenVault(sys.db, kms, cfg);
  const repoSync = new Queue<RepoSyncJob>(QUEUES.repoSync, {
    connection: redis,
    defaultJobOptions: { removeOnComplete: true, removeOnFail: 500, attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
  });
  const agent = new Queue<AgentJob>(QUEUES.agent, {
    connection: redis,
    // Retries cover provider outages; each retry resumes the run from its saved transcript.
    defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000, attempts: 4, backoff: { type: 'exponential', delay: 15_000 } },
  });
  const blobs = new PgBlobStore(sys.db);
  const providers = createProviderRegistry({ anthropic: { baseURL: env.ANTHROPIC_BASE_URL } });
  const credentials = new CredentialService({ app: app.db, sys: sys.db, kms, providers });
  return {
    env,
    app: app.db,
    sys: sys.db,
    kms,
    cfg,
    vault,
    cache,
    repoAccess: new RepoAccessService({ app: app.db, sys: sys.db, vault, cache, cfg }),
    queues: { repoSync: repoSync as unknown as JobQueue<RepoSyncJob>, agent: agent as unknown as JobQueue<AgentJob> },
    providers,
    credentials,
    gateway: new LlmGateway({ sys: sys.db, providers, credentials }),
    blobs,
    builderJobs: new BuilderJobs({
      sys: sys.db,
      cache,
      blobs,
      bus: publishBus((c, m) => redis.publish(c, m)),
      enqueueAgent: (data, jobId) => agent.add('run', data, { jobId }),
    }),
    publisher: new Publisher({ sys: sys.db, vault, cfg, cache, webUrl: env.WEB_URL }),
    liveLogs: async (jobId) =>
      (await redis.lrange(liveLogsKey(jobId), 0, -1)).map((e) => (JSON.parse(e) as { data: string }).data).join(''),
    close: async () => {
      await Promise.all([repoSync.close(), agent.close()]);
      await Promise.all([app.close(), sys.close()]);
      redis.disconnect();
    },
  };
}
