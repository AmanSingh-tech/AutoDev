import { createSystemDb, eq, schema } from '@autodev/db';
import { testKms, TEST_SYSTEM_URL, truncateAll } from '@autodev/db/testing';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testCfg } from '../test/helpers';
import { GitHubReauthRequired } from './errors';
import type { TokenSet } from './oauth';
import { TokenVault } from './vault';

const sys = createSystemDb(TEST_SYSTEM_URL);
afterAll(() => sys.close());

let userId: string;
beforeEach(async () => {
  await truncateAll(sys.db);
  const [u] = await sys.db.insert(schema.users).values({ githubUserId: 1, githubLogin: 'u' }).returning();
  userId = u!.id;
});

const hours = (h: number) => new Date(Date.now() + h * 3600_000);
const tokens = (access: string, accessExpiresAt: Date | null): TokenSet => ({
  accessToken: access,
  refreshToken: 'ghr_refresh',
  accessExpiresAt,
  refreshExpiresAt: hours(24 * 30),
});

describe('TokenVault', () => {
  it('stores tokens encrypted and hands back the plaintext only inside the callback', async () => {
    const vault = new TokenVault(sys.db, testKms, testCfg);
    await vault.store(userId, tokens('ghu_secret_access', hours(8)));
    const [row] = await sys.db.select().from(schema.githubTokens).where(eq(schema.githubTokens.userId, userId));
    expect(row!.accessTokenEnc.toString('latin1')).not.toContain('ghu_secret');
    await expect(vault.withToken(userId, async (t) => t)).resolves.toBe('ghu_secret_access');
  });

  it('refreshes a token that is about to expire, and only once under concurrency', async () => {
    const refresh = vi.fn(async () => tokens('ghu_new', hours(8)));
    const vault = new TokenVault(sys.db, testKms, testCfg, refresh);
    await vault.store(userId, tokens('ghu_old', new Date(Date.now() + 60_000)));

    const results = await Promise.all([1, 2, 3].map(() => vault.withToken(userId, async (t) => t)));
    expect(results).toEqual(['ghu_new', 'ghu_new', 'ghu_new']);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(testCfg, 'ghr_refresh');
  });

  it('marks the token revoked and asks for re-auth when the refresh token is rejected', async () => {
    const refresh = vi.fn(async () => {
      throw new GitHubReauthRequired('bad_refresh_token');
    });
    const vault = new TokenVault(sys.db, testKms, testCfg, refresh);
    await vault.store(userId, tokens('ghu_old', new Date(Date.now() - 1000)));

    await expect(vault.withToken(userId, async (t) => t)).rejects.toBeInstanceOf(GitHubReauthRequired);
    await expect(vault.withToken(userId, async (t) => t)).rejects.toBeInstanceOf(GitHubReauthRequired);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('asks for re-auth when there is no token at all', async () => {
    const vault = new TokenVault(sys.db, testKms, testCfg);
    await expect(vault.withToken(userId, async (t) => t)).rejects.toBeInstanceOf(GitHubReauthRequired);
  });
});
