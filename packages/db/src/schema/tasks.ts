import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, unique, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { createdAt, id, tsz, updatedAt } from './_shared';
import { actorType, branchMode, taskMode, taskPriority, taskStatus } from './enums';
import { users } from './identity';
import { orgs } from './orgs';
import { repos } from './repos';

export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    /** Per-org sequence; `key` is the org prefix at creation time plus this number (AD-142). */
    number: integer('number').notNull(),
    key: text('key').notNull(),
    title: text('title').notNull(),
    descriptionMd: text('description_md').notNull().default(''),
    acceptanceCriteriaMd: text('acceptance_criteria_md').notNull().default(''),
    priority: taskPriority('priority').notNull().default('medium'),
    status: taskStatus('status').notNull().default('draft'),
    mode: taskMode('mode').notNull(),
    /** Repo-relative folder the agent may read and edit. Null means the whole repo. */
    scopePath: text('scope_path'),
    branchMode: branchMode('branch_mode').notNull(),
    /** Existing-branch mode: the branch to start from and push to. */
    targetBranch: text('target_branch'),
    /** The branch the agent pushes to: autodev/<KEY>-<slug> (new) or targetBranch (existing). */
    workBranch: text('work_branch').notNull(),
    /** Commit the virtual workspace is based on, pinned when the agent starts (A-4). */
    baseSha: text('base_sha'),
    relatedTaskId: uuid('related_task_id').references((): AnyPgColumn => tasks.id, { onDelete: 'set null' }),
    extraContext: text('extra_context'),
    createPrOnCompletion: boolean('create_pr_on_completion').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** Whose GitHub token, builder and budget the task uses. */
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Written by the agent's finish(summary). Fed to follow-up tasks that link this one. */
    summaryMd: text('summary_md'),
    /** One line per changed file, from the agent's finish call (for the PR's Changes section). */
    changeNotes: jsonb('change_notes').$type<{ path: string; note: string }[]>().notNull().default([]),
    lastPushedSha: text('last_pushed_sha'),
    lastPushedAt: tsz('last_pushed_at'),
    /** The stale-branch job notifies the owner once per pushed state. */
    staleNotifiedAt: tsz('stale_notified_at'),
    tokenCapOverride: bigint('token_cap_override', { mode: 'number' }),
    completedAt: tsz('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('tasks_org_number_uq').on(t.orgId, t.number),
    unique('tasks_org_key_uq').on(t.orgId, t.key),
    index('tasks_board_idx').on(t.orgId, t.repoId, t.status),
    index('tasks_owner_idx').on(t.orgId, t.ownerId),
    check('tasks_existing_needs_target', sql`(${t.branchMode} = 'existing') = (${t.targetBranch} is not null)`),
    check('tasks_title_length', sql`char_length(${t.title}) between 1 and 200`),
    check('tasks_scope_path_relative', sql`${t.scopePath} is null or (${t.scopePath} !~ '(^/|\\.\\.)')`),
    check('tasks_not_self_related', sql`${t.relatedTaskId} is distinct from ${t.id}`),
  ],
);

/** Append-only history of a task: status changes, edits, agent milestones. */
export const taskEvents = pgTable(
  'task_events',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    actorType: actorType('actor_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    fromStatus: taskStatus('from_status'),
    toStatus: taskStatus('to_status'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('task_events_task_idx').on(t.taskId, t.createdAt)],
);
