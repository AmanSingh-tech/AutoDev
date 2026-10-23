import { QUEUES, type AgentJob, type ChatJob, type CodeIndexJob, type GroupAgentJob, type InsightsJob, type JobQueue, type RepoSyncJob } from '@autodev/config';
import { createKeyWrapper, type KeyWrapper } from '@autodev/crypto';
import { createAppDb, createSystemDb, type AppDb, type SystemDb } from '@autodev/db';
import {
  githubConfigFromEnv,
  RepoAccessService,
  TokenVault,
  type GitHubConfig,
  type KvCache,
} from '@autodev/github';
import { BuilderJobs, liveLogsKey, Publisher, publishBus } from '@autodev/agent';
import { createBlobStore, type BlobStore } from '@autodev/storage';
import { createProviderRegistry, CredentialService, LlmGateway, type ProviderRegistry } from '@autodev/llm';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { billingEnabled, StripeClient, type BillingConfig } from '@autodev/billing';
import type { ApiEnv } from './env';
import { redisCache } from './redis-cache';
import { EventHub } from '@autodev/events';
import { ChangeBridge } from './events/change-bridge';

export interface Deps {
  env: Pick<ApiEnv, 'WEB_URL' | 'AUTH_SECRET' | 'NODE_ENV' | 'BUILDER_GATEWAY_URL'>;
  app: AppDb;
  sys: SystemDb;
  kms: KeyWrapper;
  cfg: GitHubConfig;
  vault: TokenVault;
  cache: KvCache;
  repoAccess: RepoAccessService;
  queues: { repoSync: JobQueue<RepoSyncJob>; agent: JobQueue<AgentJob>; chat: JobQueue<ChatJob>; codeIndex: JobQueue<CodeIndexJob>; insights: JobQueue<InsightsJob>; groupAgent: JobQueue<GroupAgentJob> };
  providers: ProviderRegistry;
  credentials: CredentialService;
  gateway: LlmGateway;
  blobs: BlobStore;
  builderJobs: BuilderJobs;
  publisher: Publisher;
  /** Shared LISTEN connection that feeds the task-change SSE streams. */
  /** Live events for the SSE streams. One Redis subscriber per process. */
  events: EventHub;
  /** Shared Redis connection (event history, publishing). Not for subscriptions. */
  redis: Redis;
  /** Turns committed row changes into events. Started by main.ts, not by tests. */
  bridge: ChangeBridge;
  /** Billing (B-6). `stripe` is null when billing is off (no STRIPE_SECRET_KEY). */
  billing: { cfg: BillingConfig; stripe: StripeClient | null };
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
  const chat = new Queue<ChatJob>(QUEUES.chat, {
    connection: redis,
    defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000, attempts: 2, backoff: { type: 'fixed', delay: 5000 } },
  });
  // Finished and failed jobs are removed so the per-repo job id frees up (see apps/worker/src/code-index.ts).
  const codeIndex = new Queue<CodeIndexJob>(QUEUES.codeIndex, {
    connection: redis,
    defaultJobOptions: { removeOnComplete: true, removeOnFail: true, attempts: 3, backoff: { type: 'exponential', delay: 60_000 } },
  });
  // Insights jobs run on the worker's maintenance queue; finished ones are removed so the per-org id frees up.
  const maintenance = new Queue<InsightsJob>(QUEUES.maintenance, { connection: redis, defaultJobOptions: { removeOnComplete: true, removeOnFail: true } });
  const groupAgent = new Queue<GroupAgentJob>(QUEUES.groupAgent, { connection: redis, defaultJobOptions: { removeOnComplete: true, removeOnFail: 500 } });
  const blobs = createBlobStore(env, sys.db);
  const events = new EventHub(redis.duplicate());
  const bridge = new ChangeBridge({ databaseUrl: env.DATABASE_URL, redis });
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
    queues: {
      repoSync: repoSync as unknown as JobQueue<RepoSyncJob>,
      agent: agent as unknown as JobQueue<AgentJob>,
      chat: chat as unknown as JobQueue<ChatJob>,
      codeIndex: codeIndex as unknown as JobQueue<CodeIndexJob>,
      insights: maintenance as unknown as JobQueue<InsightsJob>,
      groupAgent: groupAgent as unknown as JobQueue<GroupAgentJob>,
    },
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
    billing: { cfg: env, stripe: billingEnabled(env) ? new StripeClient({ secretKey: env.STRIPE_SECRET_KEY!, apiUrl: env.STRIPE_API_URL }) : null },
    events,
    bridge,
    redis,
    liveLogs: async (jobId) =>
      (await redis.lrange(liveLogsKey(jobId), 0, -1)).map((e) => (JSON.parse(e) as { data: string }).data).join(''),
    close: async () => {
      await Promise.all([repoSync.close(), agent.close(), chat.close(), codeIndex.close()]);
      await bridge.close();
      await events.close();
      await Promise.all([app.close(), sys.close()]);
      redis.disconnect();
    },
  };
}
