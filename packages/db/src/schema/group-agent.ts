import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, numeric, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, tsz, updatedAt } from './_shared';
import { findingKind, findingSeverity, groupAgentRunKind, recommendationStatus } from './enums';
import { users } from './identity';
import { orgs } from './orgs';
import { repos } from './repos';
import { tasks } from './tasks';

/**
 * Group Agent settings (B-5). The row with no repo is the org's: on/off (off by default), its own
 * monthly AI budget and weekly PR cap. A row per repo can stop scans for that repo, set its safety
 * level (1 suggest only, 2 draft PR, 3 normal PR for low-risk fixes) and name its maintainer, whose
 * builder runs the bot's tests and who owns its tasks.
 */
export const agentPolicies = pgTable(
  'agent_policies',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(false),
    monthlyBudgetUsd: numeric('monthly_budget_usd', { precision: 12, scale: 2 }),
    weeklyPrCap: integer('weekly_pr_cap').notNull().default(5),
    safetyLevel: integer('safety_level').notNull().default(2),
    maintainerUserId: uuid('maintainer_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('agent_policies_target_uq').on(t.orgId, t.repoId).nullsNotDistinct(),
    check('agent_policies_safety_level', sql`${t.safetyLevel} between 1 and 3`),
    check('agent_policies_pr_cap', sql`${t.weeklyPrCap} between 0 and 100`),
  ],
);

/**
 * What a scan detected. `fingerprint` identifies the same problem across runs, so it's reported once;
 * it resolves on its own when a later run doesn't see it. Written by the worker only.
 */
export const groupAgentFindings = pgTable(
  'group_agent_findings',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** Null for findings across repos (the repos are in `details`) and org-wide ones. */
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'cascade' }),
    kind: findingKind('kind').notNull(),
    severity: findingSeverity('severity').notNull(),
    fingerprint: text('fingerprint').notNull(),
    title: text('title').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    firstSeenAt: tsz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: tsz('last_seen_at').notNull().defaultNow(),
    resolvedAt: tsz('resolved_at'),
    lastRunId: uuid('last_run_id'),
  },
  (t) => [unique('group_agent_findings_fingerprint_uq').on(t.orgId, t.fingerprint), index('group_agent_findings_open_idx').on(t.orgId, t.repoId, t.resolvedAt)],
);

/** The action proposed for a finding, and what people did with it. */
export const recommendations = pgTable(
  'recommendations',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    findingId: uuid('finding_id')
      .notNull()
      .references(() => groupAgentFindings.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'cascade' }),
    status: recommendationStatus('status').notNull().default('open'),
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull(),
    /** dependency_bump and lint_fix can become bot PRs (Part 2); task and investigate are for people. */
    fixKind: text('fix_kind').notNull(),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    dismissedBy: uuid('dismissed_by').references(() => users.id, { onDelete: 'set null' }),
    dismissedReason: text('dismissed_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('recommendations_finding_uq').on(t.findingId),
    index('recommendations_org_status_idx').on(t.orgId, t.status),
    check('recommendations_fix_kind', sql`${t.fixKind} in ('dependency_bump', 'lint_fix', 'task', 'investigate')`),
  ],
);

/** Each scan and each weekly digest, with what it found or reported. Written by the worker only. */
export const groupAgentRuns = pgTable(
  'group_agent_runs',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    kind: groupAgentRunKind('kind').notNull(),
    status: text('status').notNull().default('running'),
    /** Scans: counts and per-check errors. Digests: health per repo, top risks, new and resolved counts. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    startedAt: tsz('started_at').notNull().defaultNow(),
    finishedAt: tsz('finished_at'),
  },
  (t) => [index('group_agent_runs_org_idx').on(t.orgId, t.kind, t.startedAt), check('group_agent_runs_status', sql`${t.status} in ('running', 'succeeded', 'failed')`)],
);
