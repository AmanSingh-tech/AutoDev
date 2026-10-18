import type { KvCache } from '@autodev/github';
import type { Redis } from 'ioredis';

export function redisCache(redis: Redis): KvCache {
  return {
    get: (k) => redis.get(k),
    set: async (k, v, ttl) => {
      await redis.set(k, v, 'EX', ttl);
    },
    setIfAbsent: async (k, v, ttl) => (await redis.set(k, v, 'EX', ttl, 'NX')) === 'OK',
    del: async (k) => {
      await redis.del(k);
    },
    incr: (k) => redis.incr(k),
  };
}
