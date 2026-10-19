import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, numeric, pgTable, primaryKey, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bytea, createdAt, id, tsz, updatedAt } from './_shared';
import { agentPhase, agentRunStatus, agentStepKind, documentKind, documentStatus, questionKind, taskStatus, workspaceFileOp } from './enums';
import { users } from './identity';
import { orgs } from './orgs';
import { repos } from './repos';
import { tasks } from './tasks';

const orgRef = () =>
  uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' });
const taskRef = () =>
  uuid('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' });

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: id(),
    orgId: orgRef(),
    taskId: taskRef(),
    phase: agentPhase('phase').notNull(),
    status: agentRunStatus('status').notNull().default('running'),
    fixCycle: integer('fix_cycle').notNull().default(0),
    model: text('model'),
    /** Blob key of the full message transcript, persisted every turn so a run can resume after a pause. */
    /** sha256 of the transcript in the blob store. Cleared after the org's snapshot retention once the task finishes. */
    transcriptHash: text('transcript_hash'),
    turns: integer('turns').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull().default('0'),
    /** Tool call the run is paused on (ask_user), answered on resume. */
    pendingToolUseId: text('pending_tool_use_id'),
    /** Loop state that must survive a pause: tool results waiting on the paused call, extra allowed paths. */
    state: jsonb('state').$type<Record<string, unknown>>().notNull().default({}),
    /** Status to return to after blocked_on_key / needs_input. */
    resumeStatus: taskStatus('resume_status'),
    error: text('error'),
    startedAt: createdAt(),
    endedAt: tsz('ended_at'),
  },
  (t) => [index('agent_runs_task_idx').on(t.taskId, t.startedAt)],
);

export const agentSteps = pgTable(
  'agent_steps',
  {
    id: id(),
    orgId: orgRef(),
    taskId: taskRef(),
    agentRunId: uuid('agent_run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: agentStepKind('kind').notNull(),
    toolName: text('tool_name'),
    /** Truncated for display; the full content lives in the transcript. */
    input: jsonb('input').$type<unknown>(),
    output: text('output'),
    isError: boolean('is_error').notNull().default(false),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
  },
  (t) => [unique('agent_steps_run_seq_uq').on(t.agentRunId, t.seq), index('agent_steps_task_idx').on(t.taskId, t.createdAt)],
);

/** Plan and LLD, versioned (v1, v2…). At most one version per kind awaits review. */
export const taskDocuments = pgTable(
  'task_documents',
  {
    id: id(),
    orgId: orgRef(),
    taskId: taskRef(),
    kind: documentKind('kind').notNull(),
    version: integer('version').notNull(),
    contentMd: text('content_md').notNull(),
    status: documentStatus('status').notNull().default('pending_review'),
    reviewerId: uuid('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
    comment: text('comment'),
    reviewedAt: tsz('reviewed_at'),
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('task_documents_version_uq').on(t.taskId, t.kind, t.version),
    uniqueIndex('task_documents_one_pending').on(t.taskId, t.kind).where(sql`${t.status} = 'pending_review'`),
  ],
);

export const taskQuestions = pgTable(
  'task_questions',
  {
    id: id(),
    orgId: orgRef(),
    taskId: taskRef(),
    agentRunId: uuid('agent_run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    kind: questionKind('kind').notNull(),
    questionMd: text('question_md').notNull(),
    /** Deviation requests: the files outside the approved design the agent wants to change. */
    paths: text('paths').array().notNull().default(sql`'{}'::text[]`),
    answerMd: text('answer_md'),
    /** Deviation requests: whether the reviewer allowed them. */
    approved: boolean('approved'),
    answeredBy: uuid('answered_by').references(() => users.id, { onDelete: 'set null' }),
    answeredAt: tsz('answered_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('task_questions_one_open').on(t.taskId).where(sql`${t.answeredAt} is null`)],
);

/** Base commit plus an overlay of changed files. There's no clone in the cloud. */
export const workspaces = pgTable('workspaces', {
  id: id(),
  orgId: orgRef(),
  taskId: taskRef().unique(),
  repoId: uuid('repo_id')
    .notNull()
    .references(() => repos.id, { onDelete: 'cascade' }),
  baseSha: text('base_sha').notNull(),
  baseRef: text('base_ref').notNull(),
  /** Bumped on every overlay write; a builder job pins the revision it tested. */
  revision: integer('revision').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workspaceFiles = pgTable(
  'workspace_files',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    orgId: orgRef(),
    op: workspaceFileOp('op').notNull(),
    /** Blob sha at the base commit (null for created files), for diffs and conflict checks. */
    baseBlobSha: text('base_blob_sha'),
    /** Current content (null when deleted). Files are capped at 1 MB. */
    content: text('content'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.path] })],
);

/**
 * Content-addressed blob storage (see packages/storage). Rows are named by the sha256 of their bytes.
 * `encoding` is 'gzip' for rows written by the store, and 'identity' for rows migrated from the
 * name-keyed table. No org column: a blob is only reachable through a row that belongs to an org.
 */
export const blobs = pgTable('blobs', {
  hash: text('hash').primaryKey(),
  size: integer('size').notNull(),
  encoding: text('encoding').notNull().default('gzip'),
  content: bytea('content').notNull(),
  createdAt: createdAt(),
});
