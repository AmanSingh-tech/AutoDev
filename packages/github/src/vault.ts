import { createWrappedDataKey, Envelope, type KeyWrapper } from '@autodev/crypto';
import { eq, schema, type SystemDb } from '@autodev/db';
import type { GitHubConfig } from './config';
import { GitHubReauthRequired } from './errors';
import { refreshUserToken, type TokenSet } from './oauth';

const { githubTokens } = schema;

/** Refresh this long before expiry, so a token never expires mid-request. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const keyContext = (userId: string) => `github_token:${userId}`;
const aad = (userId: string, kind: 'access' | 'refresh') => `github_tokens:${userId}:${kind}`;

type Row = typeof githubTokens.$inferSelect;

/**
 * The only code that can read GitHub user tokens. Tokens are decrypted in memory for one
 * call and never returned to callers that might log or serialize them.
 */
export class TokenVault {
  constructor(
    private readonly db: SystemDb,
    private readonly kms: KeyWrapper,
    private readonly cfg: GitHubConfig,
    private readonly refresh: typeof refreshUserToken = refreshUserToken,
  ) {}

  /** Stores a token set and rotates the row's data key each time. */
  async store(userId: string, tokens: TokenSet, db: Pick<SystemDb, 'insert'> = this.db) {
    const values = await this.encryptRow(userId, tokens);
    await db
      .insert(githubTokens)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: githubTokens.userId, set: { ...values, revokedAt: null } });
  }

  async revoke(userId: string) {
    await this.db
      .update(githubTokens)
      .set({ revokedAt: new Date() })
      .where(eq(githubTokens.userId, userId));
  }

  /** Hands a valid access token to `fn`, refreshing it first if it's about to expire. */
  async withToken<T>(userId: string, fn: (token: string) => Promise<T>): Promise<T> {
    const row = await this.freshRow(userId);
    const env = new Envelope(this.kms, row.dataKeyWrapped, keyContext(userId));
    return env.useSecret(row.accessTokenEnc, aad(userId, 'access'), fn);
  }

  private async freshRow(userId: string): Promise<Row> {
    const [current] = await this.db.select().from(githubTokens).where(eq(githubTokens.userId, userId));
    if (!current || current.revokedAt) throw new GitHubReauthRequired('no GitHub token on file');
    if (!this.isExpiring(current)) return current;

    try {
      return await this.refreshLocked(userId);
    } catch (e) {
      // Outside the transaction, otherwise the rollback would undo the revoke.
      if (e instanceof GitHubReauthRequired) await this.revoke(userId);
      throw e;
    }
  }

  /** Locks the row so concurrent workers refresh only once. GitHub refresh tokens are single-use. */
  private refreshLocked(userId: string): Promise<Row> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(githubTokens)
        .where(eq(githubTokens.userId, userId))
        .for('update');
      if (!row || row.revokedAt) throw new GitHubReauthRequired('no GitHub token on file');
      if (!this.isExpiring(row)) return row; // another worker refreshed it while we waited
      if (!row.refreshTokenEnc || (row.refreshExpiresAt && row.refreshExpiresAt <= new Date())) {
        throw new GitHubReauthRequired('GitHub session expired');
      }

      const env = new Envelope(this.kms, row.dataKeyWrapped, keyContext(userId));
      const next: TokenSet = await env.useSecret(row.refreshTokenEnc, aad(userId, 'refresh'), (rt) =>
        this.refresh(this.cfg, rt),
      );
      const values = await this.encryptRow(userId, next);
      const [updated] = await tx
        .update(githubTokens)
        .set(values)
        .where(eq(githubTokens.userId, userId))
        .returning();
      return updated!;
    });
  }

  private isExpiring(row: Row): boolean {
    return row.accessExpiresAt !== null && row.accessExpiresAt.getTime() - Date.now() < REFRESH_SKEW_MS;
  }

  private async encryptRow(userId: string, t: TokenSet) {
    const { wrapped, kmsKeyId } = await createWrappedDataKey(this.kms, keyContext(userId));
    const env = new Envelope(this.kms, wrapped, keyContext(userId));
    return {
      accessTokenEnc: await env.encrypt(t.accessToken, aad(userId, 'access')),
      refreshTokenEnc: t.refreshToken ? await env.encrypt(t.refreshToken, aad(userId, 'refresh')) : null,
      dataKeyWrapped: wrapped,
      kmsKeyId,
      accessExpiresAt: t.accessExpiresAt,
      refreshExpiresAt: t.refreshExpiresAt,
    };
  }
}
