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
    /** Cross-repo sync (B-3): the task in a linked repo whose change this one ports. */
    sourceTaskId: uuid('source_task_id').references((): AnyPgColumn => tasks.id, { onDelete: 'set null' }),
    /** What is being ported, frozen when the task was created: source task, PR, mapping notes and diff. */
    sourceContextMd: text('source_context_md'),
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
    /**
     * A Group Agent fix (B-5): metered under the `group_agent` policy and its own budget, pushed and
     * opened as a PR by the GitHub App bot. The owner is the repo's maintainer, whose builder tests it.
     */
    byGroupAgent: boolean('by_group_agent').notNull().default(false),
    /** Jira sync (B-7): the linked issue, its status in Jira, and the task status last reported there. */
    jiraIssueKey: text('jira_issue_key'),
    jiraIssueStatus: text('jira_issue_status'),
    jiraSyncedStatus: text('jira_synced_status'),
    /** Prompt guide (B-1): the rule-based draft score from @autodev/protocol, set on create and edit. */
    promptScore: integer('prompt_score'),
    promptScoreDetails: jsonb('prompt_score_details').$type<{ version: number; flags: string[] }>(),
    promptCheckedAt: tsz('prompt_checked_at'),
    completedAt: tsz('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('tasks_org_number_uq').on(t.orgId, t.number),
    unique('tasks_org_key_uq').on(t.orgId, t.key),
    index('tasks_board_idx').on(t.orgId, t.repoId, t.status),
    index('tasks_owner_idx').on(t.orgId, t.ownerId),
    index('tasks_jira_idx').on(t.orgId, t.jiraIssueKey).where(sql`${t.jiraIssueKey} is not null`),
    check('tasks_existing_needs_target', sql`(${t.branchMode} = 'existing') = (${t.targetBranch} is not null)`),
    check('tasks_title_length', sql`char_length(${t.title}) between 1 and 200`),
    check('tasks_scope_path_relative', sql`${t.scopePath} is null or (${t.scopePath} !~ '(^/|\\.\\.)')`),
    check('tasks_prompt_score_range', sql`${t.promptScore} is null or ${t.promptScore} between 0 and 100`),
    check('tasks_not_self_related', sql`${t.relatedTaskId} is distinct from ${t.id}`),
    check('tasks_not_self_source', sql`${t.sourceTaskId} is distinct from ${t.id}`),
    check('tasks_source_context_length', sql`${t.sourceContextMd} is null or char_length(${t.sourceContextMd}) <= 60000`),
    index('tasks_source_idx').on(t.sourceTaskId),
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
