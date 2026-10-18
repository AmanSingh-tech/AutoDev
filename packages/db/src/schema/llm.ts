import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, createdAt, id, tsz, updatedAt } from './_shared';
import { budgetScope, credentialScope, credentialStatus, llmProvider, llmUseCase } from './enums';
import { users } from './identity';
import { orgs, teams } from './orgs';
import { repos } from './repos';

const ZERO_UUID = sql.raw(`'00000000-0000-0000-0000-000000000000'::uuid`);

/**
 * BYOK keys. The secret is envelope-encrypted with the org's data key (AAD binds it to the row).
 * The app role can write secret_enc but never SELECT it (column grants in the A-2 migration).
 * One active key per (org, provider, scope, team/user): rotation supersedes the old row.
 */
export const llmCredentials = pgTable(
  'llm_credentials',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    scope: credentialScope('scope').notNull(),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    provider: llmProvider('provider').notNull(),
    label: text('label').notNull(),
    secretEnc: bytea('secret_enc').notNull(),
    dataKeyVersion: integer('data_key_version').notNull(),
    last4: text('last4').notNull(),
    /** Non-secret provider settings (base URL, region, deployment). */
    config: jsonb('config').$type<Record<string, string>>().notNull().default({}),
    status: credentialStatus('status').notNull().default('active'),
    lastValidatedAt: tsz('last_validated_at'),
    lastError: text('last_error'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    rotatedFromId: uuid('rotated_from_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'llm_credentials_scope_target',
      sql`(${t.scope} = 'org' and ${t.teamId} is null and ${t.userId} is null)
       or (${t.scope} = 'team' and ${t.teamId} is not null and ${t.userId} is null)
       or (${t.scope} = 'user' and ${t.userId} is not null and ${t.teamId} is null)`,
    ),
    uniqueIndex('llm_credentials_one_active')
      .on(
        t.orgId,
        t.provider,
        t.scope,
        sql`coalesce(${t.teamId}, ${ZERO_UUID})`,
        sql`coalesce(${t.userId}, ${ZERO_UUID})`,
      )
      .where(sql`${t.status} = 'active'`),
    index('llm_credentials_org_idx').on(t.orgId, t.status),
  ],
);

export const modelPolicies = pgTable(
  'model_policies',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    useCase: llmUseCase('use_case').notNull(),
    provider: llmProvider('provider').notNull(),
    model: text('model').notNull(),
    /** Hard cap on the tokens (input + output + cache writes) one task may consume. */
    maxTokensPerTask: bigint('max_tokens_per_task', { mode: 'number' }).notNull(),
    maxOutputTokens: integer('max_output_tokens').notNull(),
    effort: text('effort'),
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('model_policies_org_use_case_uq').on(t.orgId, t.useCase),
    check('model_policies_caps_positive', sql`${t.maxTokensPerTask} > 0 and ${t.maxOutputTokens} > 0`),
  ],
);

const usd = (name: string) => numeric(name, { precision: 12, scale: 6 });

/**
 * USD per million tokens. org_id NULL rows are the global defaults (seeded by migration);
 * an org's edit adds an org-specific override. Rows are effective-dated and never edited in place,
 * and token_usage freezes the computed cost, so price changes never rewrite history.
 */
export const modelPrices = pgTable(
  'model_prices',
  {
    id: id(),
    orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'cascade' }),
    provider: llmProvider('provider').notNull(),
    model: text('model').notNull(),
    inputPerMtok: usd('input_per_mtok').notNull(),
    outputPerMtok: usd('output_per_mtok').notNull(),
    cacheWrite5mPerMtok: usd('cache_write_5m_per_mtok').notNull(),
    cacheWrite1hPerMtok: usd('cache_write_1h_per_mtok').notNull(),
    cacheReadPerMtok: usd('cache_read_per_mtok').notNull(),
    currency: text('currency').notNull().default('USD'),
    effectiveFrom: tsz('effective_from').notNull().defaultNow(),
    effectiveTo: tsz('effective_to'),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('model_prices_one_current')
      .on(sql`coalesce(${t.orgId}, ${ZERO_UUID})`, t.provider, t.model)
      .where(sql`${t.effectiveTo} is null`),
  ],
);

export const budgets = pgTable(
  'budgets',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    scope: budgetScope('scope').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    limitUsd: numeric('limit_usd', { precision: 12, scale: 2 }).notNull(),
    softPct: integer('soft_pct').notNull().default(80),
    hardBlock: boolean('hard_block').notNull().default(true),
    /** First day of the month a soft/hard alert was last sent, so each fires once per month. */
    lastSoftAlertMonth: date('last_soft_alert_month'),
    lastHardAlertMonth: date('last_hard_alert_month'),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('budgets_scope_target', sql`(${t.scope} = 'org') = (${t.userId} is null)`),
    check('budgets_soft_pct_range', sql`${t.softPct} between 1 and 100`),
    check('budgets_limit_positive', sql`${t.limitUsd} > 0`),
    uniqueIndex('budgets_one_per_target').on(t.orgId, t.scope, sql`coalesce(${t.userId}, ${ZERO_UUID})`),
  ],
);

/**
 * One row per LLM call, straight from the provider's usage fields. Partitioned by month on
 * created_at (the migration adds PARTITION BY; Drizzle can't express it). task_id and
 * agent_run_id get foreign keys when those tables arrive in A-4.
 */
export const tokenUsage = pgTable(
  'token_usage',
  {
    id: uuid('id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'set null' }),
    taskId: uuid('task_id'),
    agentRunId: uuid('agent_run_id'),
    credentialId: uuid('credential_id'),
    credentialScope: credentialScope('credential_scope'),
    provider: llmProvider('provider').notNull(),
    model: text('model').notNull(),
    useCase: llmUseCase('use_case').notNull(),
    providerRequestId: text('provider_request_id'),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheWrite5mTokens: bigint('cache_write_5m_tokens', { mode: 'number' }).notNull().default(0),
    cacheWrite1hTokens: bigint('cache_write_1h_tokens', { mode: 'number' }).notNull().default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull().default('0'),
    /** False when no price was found for the model, so the cost is 0 and needs attention. */
    priced: boolean('priced').notNull().default(true),
    modelPriceId: uuid('model_price_id'),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    index('token_usage_org_created_idx').on(t.orgId, t.createdAt),
    index('token_usage_org_user_created_idx').on(t.orgId, t.userId, t.createdAt),
    index('token_usage_task_idx').on(t.taskId),
  ],
);
