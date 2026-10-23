import type { AgentJob, ChatJob, CodeIndexJob, GroupAgentJob, InsightsJob, JobQueue, RepoSyncJob } from '@autodev/config';
import { createAppDb, createSystemDb, schema } from '@autodev/db';
import { testKms, TEST_APP_URL, TEST_SYSTEM_URL } from '@autodev/db/testing';
import { MemoryCache, RepoAccessService, TokenVault, type GitHubConfig } from '@autodev/github';
import { BuilderJobs, Publisher } from '@autodev/agent';
import { MemoryBlobStore } from '@autodev/storage';
import type { GatewayMessage } from '@autodev/protocol';
import { AnthropicProvider, CredentialService, LlmGateway, staticRegistry } from '@autodev/llm';
import { setupServer } from 'msw/node';
import type { Deps } from '../src/deps';
import { createCaller } from '../src/trpc/router';
import { EventHub } from '@autodev/events';
import { Redis } from 'ioredis';
import { ChangeBridge } from '../src/events/change-bridge';

export const API = 'http://github.test/api';
export const WEB_URL = 'http://web.test';
export const ANTHROPIC = 'http://anthropic.test';
export const AUTH_SECRET = 'test-auth-secret-'.padEnd(48, 'x');

export const testCfg: GitHubConfig = {
  appId: 1,
  appSlug: 'autodev-test',
  privateKey: 'unused',
  clientId: 'Iv1.test',
  clientSecret: 'secret',
  webhookSecret: 'whsec_test_123456',
  apiUrl: API,
  webUrl: 'http://github.test',
};

export const msw = setupServer();

export function createTestDeps() {
  const app = createAppDb(TEST_APP_URL);
  const sys = createSystemDb(TEST_SYSTEM_URL);
  const cache = new MemoryCache();
  const vault = new TokenVault(sys.db, testKms, testCfg);
  const jobs: { name: string; data: RepoSyncJob }[] = [];
  const repoSync: JobQueue<RepoSyncJob> = {
    add: async (name, data) => {
      jobs.push({ name, data });
    },
  };
  const providers = staticRegistry([new AnthropicProvider({ baseURL: ANTHROPIC, maxRetries: 0 })]);
  const credentials = new CredentialService({ app: app.db, sys: sys.db, kms: testKms, providers });
  const agentJobs: { name: string; data: AgentJob; jobId?: string }[] = [];
  const agent: JobQueue<AgentJob> = {
    add: async (name, data, opts) => {
      agentJobs.push({ name, data, jobId: opts?.jobId });
    },
  };
  const chatJobs: { name: string; data: ChatJob; jobId?: string }[] = [];
  const chat: JobQueue<ChatJob> = {
    add: async (name, data, opts) => {
      chatJobs.push({ name, data, jobId: opts?.jobId });
    },
  };
  const codeIndexJobs: { name: string; data: CodeIndexJob; jobId?: string; delay?: number }[] = [];
  const codeIndex: JobQueue<CodeIndexJob> = {
    add: async (name, data, opts) => {
      codeIndexJobs.push({ name, data, jobId: opts?.jobId, delay: opts?.delay });
    },
  };
  const insightsJobs: { name: string; data: InsightsJob; jobId?: string }[] = [];
  const insights: JobQueue<InsightsJob> = {
    add: async (name, data, opts) => {
      insightsJobs.push({ name, data, jobId: opts?.jobId });
    },
  };
  const groupAgentJobs: { name: string; data: GroupAgentJob; jobId?: string }[] = [];
  const groupAgent: JobQueue<GroupAgentJob> = {
    add: async (name, data, opts) => {
      groupAgentJobs.push({ name, data, jobId: opts?.jobId });
    },
  };
  const blobs = new MemoryBlobStore();
  // Events need a real Redis. Tests use their own database number so nothing else is touched.
  const redis = new Redis(process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/14', { maxRetriesPerRequest: 1 });
  const events = new EventHub(redis.duplicate());
  const bridge = new ChangeBridge({ databaseUrl: TEST_APP_URL, redis });
  const sentToBuilders: { builderId: string; msg: GatewayMessage }[] = [];
  const builderJobs = new BuilderJobs({
    sys: sys.db,
    cache,
    blobs,
    bus: { send: async (builderId, msg) => void sentToBuilders.push({ builderId, msg }) },
    enqueueAgent: (data, jobId) => agent.add('run', data, { jobId }),
  });
  const deps: Deps = {
    env: { WEB_URL, AUTH_SECRET, NODE_ENV: 'test', BUILDER_GATEWAY_URL: 'ws://gateway.test/builder' },
    app: app.db,
    sys: sys.db,
    kms: testKms,
    cfg: testCfg,
    vault,
    cache,
    repoAccess: new RepoAccessService({ app: app.db, sys: sys.db, vault, cache, cfg: testCfg }),
    queues: { repoSync, agent, chat, codeIndex, insights, groupAgent },
    providers,
    credentials,
    gateway: new LlmGateway({ sys: sys.db, providers, credentials }),
    blobs,
    builderJobs,
    publisher: new Publisher({ sys: sys.db, vault, cfg: testCfg, cache, webUrl: WEB_URL }),
    liveLogs: async () => 'live log so far\n',
    events,
    bridge,
    redis,
  };
  const close = async () => {
    await bridge.close();
    await events.close();
    redis.disconnect();
    await Promise.all([app.close(), sys.close()]);
  };
  return { deps, redis, jobs, agentJobs, chatJobs, codeIndexJobs, insightsJobs, groupAgentJobs, sentToBuilders, close };
}

export function callerFor(deps: Deps, userId: string | null, orgId: string | null) {
  return createCaller({ deps, userId, orgId, ip: '127.0.0.1', userAgent: 'vitest' });
}

export async function addMember(deps: Deps, orgId: string, login: string, role: 'owner' | 'admin' | 'developer' | 'viewer') {
  const [u] = await deps.sys
    .insert(schema.users)
    .values({ githubUserId: Math.floor(Math.random() * 1e9), githubLogin: login })
    .returning();
  await deps.sys.insert(schema.orgMembers).values({ orgId, userId: u!.id, role });
  return u!;
}
