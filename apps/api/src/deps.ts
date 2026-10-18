import { QUEUES, type JobQueue, type RepoSyncJob } from '@autodev/config';
import { createKeyWrapper, type KeyWrapper } from '@autodev/crypto';
import { createAppDb, createSystemDb, type AppDb, type SystemDb } from '@autodev/db';
import {
  githubConfigFromEnv,
  RepoAccessService,
  TokenVault,
  type GitHubConfig,
  type KvCache,
} from '@autodev/github';
import { createProviderRegistry, CredentialService, LlmGateway, type ProviderRegistry } from '@autodev/llm';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { ApiEnv } from './env';
import { redisCache } from './redis-cache';

export interface Deps {
  env: Pick<ApiEnv, 'WEB_URL' | 'AUTH_SECRET' | 'NODE_ENV'>;
  app: AppDb;
  sys: SystemDb;
  kms: KeyWrapper;
  cfg: GitHubConfig;
  vault: TokenVault;
  cache: KvCache;
  repoAccess: RepoAccessService;
  queues: { repoSync: JobQueue<RepoSyncJob> };
  providers: ProviderRegistry;
  credentials: CredentialService;
  gateway: LlmGateway;
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
    queues: { repoSync: repoSync as unknown as JobQueue<RepoSyncJob> },
    providers,
    credentials,
    gateway: new LlmGateway({ sys: sys.db, providers, credentials }),
    close: async () => {
      await repoSync.close();
      await Promise.all([app.close(), sys.close()]);
      redis.disconnect();
    },
  };
}
