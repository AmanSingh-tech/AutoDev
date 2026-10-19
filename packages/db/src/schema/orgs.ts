import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, createdAt, id, tsz, updatedAt } from './_shared';
import { accountType, memberStatus, orgRole, staleBranchAction, taskMode } from './enums';
import { users } from './identity';

export const orgs = pgTable(
  'orgs',
  {
    id: id(),
    githubAccountId: bigint('github_account_id', { mode: 'number' }).notNull().unique(),
    githubLogin: text('github_login').notNull(),
    accountType: accountType('account_type').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    /** This org's envelope data key, wrapped by KMS. Encrypts LLM keys and other org secrets. */
    dataKeyWrapped: bytea('data_key_wrapped').notNull(),
    kmsKeyId: text('kms_key_id').notNull(),
    dataKeyVersion: integer('data_key_version').notNull().default(1),
    defaultTaskMode: taskMode('default_task_mode').notNull().default('plan_lld'),
    staleBranchDays: integer('stale_branch_days').notNull().default(3),
    staleBranchAction: staleBranchAction('stale_branch_action').notNull().default('notify_owner'),
    defaultMemberRole: orgRole('default_member_role').notNull().default('developer'),
    maxFixCycles: integer('max_fix_cycles').notNull().default(3),
    /** Builder logs are kept this many days (7–365). */
    logRetentionDays: integer('log_retention_days').notNull().default(30),
    /** Workspace snapshots of finished tasks are kept this many days (1–90). Patches are always kept. */
    snapshotRetentionDays: integer('snapshot_retention_days').notNull().default(14),
    taskKeyPrefix: text('task_key_prefix').notNull().default('AD'),
    /** Per-org task counter. Incremented with UPDATE … RETURNING to mint task keys like AD-142. */
    taskSeq: integer('task_seq').notNull().default(0),
    /** Whether members may add their own LLM key (the user scope). */
    allowUserKeys: boolean('allow_user_keys').notNull().default(true),
    /** Room for future (Section B) settings, so they don't each need a column. */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('orgs_stale_days_range', sql`${t.staleBranchDays} between 1 and 90`),
    check('orgs_fix_cycles_range', sql`${t.maxFixCycles} between 0 and 10`),
    check('orgs_log_retention_range', sql`${t.logRetentionDays} between 7 and 365`),
    check('orgs_snapshot_retention_range', sql`${t.snapshotRetentionDays} between 1 and 90`),
    check('orgs_default_role_not_owner', sql`${t.defaultMemberRole} <> 'owner'`),
    check('orgs_key_prefix_format', sql`${t.taskKeyPrefix} ~ '^[A-Z][A-Z0-9]{1,9}$'`),
  ],
);

export const orgMembers = pgTable(
  'org_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: orgRole('role').notNull(),
    status: memberStatus('status').notNull().default('active'),
    /** The team whose LLM key applies when a member is in several teams that each have one. */
    primaryTeamId: uuid('primary_team_id'),
    joinedAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] }), index('org_members_user_idx').on(t.userId)],
);

export const teams = pgTable(
  'teams',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** Set when the team mirrors a GitHub team. Syncing comes later. */
    githubTeamId: bigint('github_team_id', { mode: 'number' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('teams_org_slug_uq').on(t.orgId, t.slug)],
);

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    index('team_members_org_user_idx').on(t.orgId, t.userId),
  ],
);

export const installations = pgTable(
  'installations',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    githubInstallationId: bigint('github_installation_id', { mode: 'number' }).notNull().unique(),
    accountLogin: text('account_login').notNull(),
    accountType: accountType('account_type').notNull(),
    permissions: jsonb('permissions').$type<Record<string, string>>().notNull().default({}),
    events: text('events').array().notNull().default(sql`'{}'::text[]`),
    installedByUserId: uuid('installed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    suspendedAt: tsz('suspended_at'),
    deletedAt: tsz('deleted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('installations_org_idx').on(t.orgId)],
);
