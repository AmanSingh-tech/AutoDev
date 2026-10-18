import { bigint, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { bytea, createdAt, id, tsz, updatedAt } from './_shared';

/** Global (not tenant-scoped): one person can belong to several orgs. */
export const users = pgTable('users', {
  id: id(),
  githubUserId: bigint('github_user_id', { mode: 'number' }).notNull().unique(),
  githubLogin: text('github_login').notNull(),
  name: text('name'),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  lastLoginAt: tsz('last_login_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * GitHub App user-to-server tokens. Each row has its own envelope data key, because users
 * aren't tied to one org. The app role has no access at all; only the system role reads it.
 */
export const githubTokens = pgTable(
  'github_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessTokenEnc: bytea('access_token_enc').notNull(),
    refreshTokenEnc: bytea('refresh_token_enc'),
    dataKeyWrapped: bytea('data_key_wrapped').notNull(),
    kmsKeyId: text('kms_key_id').notNull(),
    accessExpiresAt: tsz('access_expires_at'),
    refreshExpiresAt: tsz('refresh_expires_at'),
    revokedAt: tsz('revoked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('github_tokens_access_expires_idx').on(t.accessExpiresAt)],
);
