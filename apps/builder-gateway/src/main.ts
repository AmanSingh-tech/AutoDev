import { BuilderJobs } from '@autodev/agent';
import { createBlobStore } from '@autodev/storage';
import { coreEnv, dbEnv, loadEnv, QUEUES, redisEnv, storageEnv, type AgentJob } from '@autodev/config';
import { createSystemDb } from '@autodev/db';
import type { KvCache } from '@autodev/github';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { z } from 'zod';
import { createGateway, redisBus } from './gateway';

const env = loadEnv(coreEnv.merge(dbEnv).merge(redisEnv).merge(storageEnv).merge(z.object({ GATEWAY_PORT: z.coerce.number().int().default(4100) })));
const log = pino({ level: env.LOG_LEVEL });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const sys = createSystemDb(env.DATABASE_URL_SYSTEM);
const cache: KvCache = {
  get: (k) => redis.get(k),
  set: async (k, v, ttl) => void (await redis.set(k, v, 'EX', ttl)),
  setIfAbsent: async (k, v, ttl) => (await redis.set(k, v, 'EX', ttl, 'NX')) === 'OK',
  del: async (k) => void (await redis.del(k)),
  incr: (k) => redis.incr(k),
};
const agent = new Queue<AgentJob>(QUEUES.agent, { connection: redis, defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000, attempts: 4, backoff: { type: 'exponential', delay: 15_000 } } });
const blobs = createBlobStore(env, sys.db);
const jobs = new BuilderJobs({ sys: sys.db, cache, blobs, bus: redisBus(redis), enqueueAgent: (data, jobId) => agent.add('run', data, { jobId }) });

const gw = createGateway({ sys: sys.db, redis, sub, cache, blobs, jobs, log });
gw.server.listen(env.GATEWAY_PORT, () => log.info({ port: env.GATEWAY_PORT }, 'builder gateway listening'));

const shutdown = async () => {
  await gw.close();
  await agent.close();
  await sys.close();
  redis.disconnect();
  sub.disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
