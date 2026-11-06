import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, numeric, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, tsz, updatedAt } from './_shared';
import { users } from './identity';
import { orgs } from './orgs';

/**
 * Autopilot: a person queues tasks, and the agent works through them on its own in their time
 * window (overnight by default), approving its own plans and designs, assuming instead of asking,
 * and opening draft PRs for review in the morning. One row per person per org.
 */
export const autopilotSettings = pgTable(
  'autopilot_settings',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(false),
    /** IANA time zone the window is in, e.g. Asia/Kolkata. */
    timezone: text('timezone').notNull().default('UTC'),
    /** Minutes after local midnight. The window may wrap past midnight (19:00 → 07:00). */
    startMinute: integer('start_minute').notNull().default(19 * 60),
    endMinute: integer('end_minute').notNull().default(7 * 60),
    /** ISO weekdays (1 = Monday) on which a window may start. */
    days: integer('days').array().notNull().default(sql`'{1,2,3,4,5}'::int[]`),
    nightlyBudgetUsd: numeric('nightly_budget_usd', { precision: 10, scale: 2 }).notNull().default('20.00'),
    maxTasks: integer('max_tasks').notNull().default(5),
    /** "Run until morning": a one-off window that ends at this time, regardless of the schedule. */
    runUntil: tsz('run_until'),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    check('autopilot_window_range', sql`${t.startMinute} between 0 and 1439 and ${t.endMinute} between 0 and 1439`),
    check('autopilot_max_tasks_range', sql`${t.maxTasks} between 1 and 50`),
  ],
);

/** One Autopilot session (a night, or a "run until morning"): what it started, spent and why it stopped. */
export const autopilotRuns = pgTable(
  'autopilot_runs',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('running'),
    startedAt: createdAt(),
    endsAt: tsz('ends_at').notNull(),
    endedAt: tsz('ended_at'),
    /** Why it stopped starting tasks: window_ended, budget, max_tasks, queue_empty, stopped. */
    stopReason: text('stop_reason'),
    tasksStarted: integer('tasks_started').notNull().default(0),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
    /** When the person opened the morning review, so the "new" badge goes away. */
    reviewedAt: tsz('reviewed_at'),
    updatedAt: updatedAt(),
  },
  (t) => [index('autopilot_runs_user_idx').on(t.orgId, t.userId, t.startedAt)],
);
