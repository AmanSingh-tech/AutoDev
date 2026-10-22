import { bigint, date, index, integer, numeric, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { id, tsz } from './_shared';
import { leaderboardPeriod, leaderboardScope } from './enums';
import { users } from './identity';
import { orgs } from './orgs';
import { repos } from './repos';

/**
 * Insights (B-4): one row per org, UTC day, person and repo, rebuilt nightly from token_usage, tasks,
 * pull_requests and task_documents. Task numbers count for the task's owner. Teams are derived from
 * current membership at query time. Written only by the worker (the app role can only read).
 */
export const userMetricsDaily = pgTable(
  'user_metrics_daily',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'cascade' }),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull().default('0'),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    llmCalls: integer('llm_calls').notNull().default(0),
    tasksCreated: integer('tasks_created').notNull().default(0),
    tasksResolved: integer('tasks_resolved').notNull().default(0),
    prsMerged: integer('prs_merged').notNull().default(0),
    /** Plan and LLD v1s reviewed that day, and how many of them were approved as they were. */
    docsReviewed: integer('docs_reviewed').notNull().default(0),
    docsFirstPass: integer('docs_first_pass').notNull().default(0),
    /** Task created → PR merged, one entry per merge, so medians over any period are exact. */
    mergeMinutes: integer('merge_minutes').array().notNull().default([]),
    promptScoreSum: integer('prompt_score_sum').notNull().default(0),
    promptScoreCount: integer('prompt_score_count').notNull().default(0),
  },
  (t) => [
    unique('user_metrics_daily_uq').on(t.orgId, t.day, t.userId, t.repoId).nullsNotDistinct(),
    index('user_metrics_daily_user_idx').on(t.orgId, t.userId, t.day),
  ],
);

/** Ranked leaderboards per period and scope, rebuilt nightly for the current and previous period. */
export const leaderboardSnapshots = pgTable(
  'leaderboard_snapshots',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    period: leaderboardPeriod('period').notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    scope: leaderboardScope('scope').notNull(),
    /** The team or repo; null for the org-wide board. */
    scopeId: uuid('scope_id'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rank: integer('rank').notNull(),
    impactScore: numeric('impact_score', { precision: 12, scale: 4 }).notNull(),
    prsMerged: integer('prs_merged').notNull(),
    /** First-pass approval rate; null when nothing was reviewed (a neutral 0.75 is used in the score). */
    approvalRate: numeric('approval_rate', { precision: 5, scale: 4 }),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull(),
    costPerPrUsd: numeric('cost_per_pr_usd', { precision: 14, scale: 6 }),
    tokens: bigint('tokens', { mode: 'number' }).notNull(),
    badges: text('badges').array().notNull().default([]),
    computedAt: tsz('computed_at').notNull().defaultNow(),
  },
  (t) => [
    unique('leaderboard_snapshots_uq').on(t.orgId, t.period, t.periodStart, t.scope, t.scopeId, t.userId).nullsNotDistinct(),
    index('leaderboard_snapshots_board_idx').on(t.orgId, t.period, t.periodStart, t.scope, t.scopeId, t.rank),
  ],
);
