/** Minimal key-value store. In production this is Redis (see apps/api). Tests use MemoryCache. */
export interface KvCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** SET NX EX. Resolves true if this call created the key. */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  del(key: string): Promise<void>;
  incr(key: string): Promise<number>;
}

export class MemoryCache implements KvCache {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string) {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(key: string, value: string, ttlSeconds: number) {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number) {
    if ((await this.get(key)) !== null) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async del(key: string) {
    this.store.delete(key);
  }

  async incr(key: string) {
    const next = Number((await this.get(key)) ?? 0) + 1;
    this.store.set(key, { value: String(next), expiresAt: Number.POSITIVE_INFINITY });
    return next;
  }
}
