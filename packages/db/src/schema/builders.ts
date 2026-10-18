import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, tsz, updatedAt } from './_shared';
import { builderJobStatus, builderKind, jobConsent } from './enums';
import { users } from './identity';
import { orgs } from './orgs';
import { repos } from './repos';
import { agentRuns } from './agent';
import { tasks } from './tasks';

/** A developer's machine running autodev-runner. It authenticates with a hashed bearer token. */
export const builders = pgTable(
  'builders',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: builderKind('kind').notNull().default('personal'),
    /** Team builders may run other members' jobs, in Docker only. */
    allowShared: boolean('allow_shared').notNull().default(false),
    /** sha256 of the builder token. The token itself is shown to the CLI once and never stored. */
    tokenHash: text('token_hash').notNull(),
    os: text('os'),
    arch: text('arch'),
    cliVersion: text('cli_version'),
    dockerAvailable: boolean('docker_available').notNull().default(false),
    maxCpus: integer('max_cpus').notNull().default(2),
    maxMemoryMb: integer('max_memory_mb').notNull().default(4096),
    lastSeenAt: tsz('last_seen_at'),
    revokedAt: tsz('revoked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('builders_token_hash_uq').on(t.tokenHash), index('builders_org_owner_idx').on(t.orgId, t.ownerUserId)],
);

/** Which repos a builder knows locally (to reuse a warm clone), and whether its first run was confirmed. */
export const builderRepoBindings = pgTable(
  'builder_repo_bindings',
  {
    builderId: uuid('builder_id')
      .notNull()
      .references(() => builders.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    localPath: text('local_path'),
    firstRunConfirmedAt: tsz('first_run_confirmed_at'),
    confirmedBy: uuid('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.builderId, t.repoId] })],
);

export const builderJobs = pgTable(
  'builder_jobs',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    /** Whose job it is: their builders run it (or a shared team builder, in Docker). */
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    builderId: uuid('builder_id').references(() => builders.id, { onDelete: 'set null' }),
    baseSha: text('base_sha').notNull(),
    workspaceRevision: integer('workspace_revision').notNull(),
    patchKey: text('patch_key').notNull(),
    patchSha256: text('patch_sha256').notNull(),
    /** Parsed .autodev.yml from the base branch (null: none, so tests are skipped). */
    configSnapshot: jsonb('config_snapshot').$type<Record<string, unknown> | null>(),
    configError: text('config_error'),
    /** The patch edits .autodev.yml, so the owner must consent before anything runs. */
    configChanged: boolean('config_changed').notNull().default(false),
    consent: jobConsent('consent').notNull().default('not_needed'),
    docker: boolean('docker').notNull().default(true),
    /** True when the agent called finish (the last test before pushing). */
    final: boolean('final').notNull().default(false),
    fixCycle: integer('fix_cycle').notNull().default(0),
    status: builderJobStatus('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    exitCode: integer('exit_code'),
    failedStep: text('failed_step'),
    failedTests: jsonb('failed_tests').$type<{ name: string; file?: string; message?: string }[]>().notNull().default([]),
    durationMs: integer('duration_ms'),
    logTail: text('log_tail'),
    logKey: text('log_key'),
    error: text('error'),
    queuedAt: createdAt(),
    offeredAt: tsz('offered_at'),
    startedAt: tsz('started_at'),
    finishedAt: tsz('finished_at'),
    offlineNotifiedAt: tsz('offline_notified_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('builder_jobs_task_idx').on(t.taskId, t.queuedAt),
    index('builder_jobs_queue_idx').on(t.orgId, t.status).where(sql`${t.status} in ('queued', 'offered', 'running')`),
  ],
);
