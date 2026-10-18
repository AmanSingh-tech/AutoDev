import { bigint, boolean, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, tsz, updatedAt } from './_shared';
import { prCreatedBy, prState } from './enums';
import { users } from './identity';
import { orgs } from './orgs';
import { repos } from './repos';
import { tasks } from './tasks';

/** PRs live on GitHub. This mirrors the ones that belong to tasks, kept in sync by webhooks. */
export const pullRequests = pgTable(
  'pull_requests',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    githubPrId: bigint('github_pr_id', { mode: 'number' }).notNull(),
    number: integer('number').notNull(),
    url: text('url').notNull(),
    headBranch: text('head_branch').notNull(),
    baseBranch: text('base_branch').notNull(),
    headSha: text('head_sha'),
    state: prState('state').notNull().default('open'),
    draft: boolean('draft').notNull().default(false),
    createdBy: prCreatedBy('created_by').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    mergedAt: tsz('merged_at'),
    closedAt: tsz('closed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('pull_requests_repo_number_uq').on(t.repoId, t.number), index('pull_requests_task_idx').on(t.taskId), index('pull_requests_gh_idx').on(t.githubPrId)],
);
