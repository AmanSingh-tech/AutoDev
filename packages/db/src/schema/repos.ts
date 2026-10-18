import { bigint, boolean, index, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, tsz, updatedAt } from './_shared';
import { repoPermission, taskMode } from './enums';
import { users } from './identity';
import { installations, orgs } from './orgs';

export const repos = pgTable(
  'repos',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => installations.id, { onDelete: 'cascade' }),
    githubRepoId: bigint('github_repo_id', { mode: 'number' }).notNull().unique(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    fullName: text('full_name').notNull(),
    defaultBranch: text('default_branch').notNull(),
    private: boolean('private').notNull(),
    archived: boolean('archived').notNull().default(false),
    lastSyncedAt: tsz('last_synced_at'),
    deletedAt: tsz('deleted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('repos_org_idx').on(t.orgId), index('repos_installation_idx').on(t.installationId)],
);

/**
 * Per-user GitHub permission cache (15-minute TTL), refreshed by webhooks.
 * It is never trusted for a push or PR: those always re-check live.
 */
export const userRepoAccess = pgTable(
  'user_repo_access',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    permission: repoPermission('permission').notNull(),
    fetchedAt: tsz('fetched_at').notNull(),
    expiresAt: tsz('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.repoId] }),
    index('user_repo_access_org_user_idx').on(t.orgId, t.userId),
  ],
);

export const repoPolicies = pgTable('repo_policies', {
  repoId: uuid('repo_id')
    .primaryKey()
    .references(() => repos.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  /** When set, every task in this repo uses this mode and the picker is disabled. */
  lockedMode: taskMode('locked_mode'),
  defaultMode: taskMode('default_mode'),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
