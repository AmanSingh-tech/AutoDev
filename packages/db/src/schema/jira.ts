import { pgTable, text, uuid, integer } from 'drizzle-orm/pg-core';
import { bytea, createdAt, tsz, updatedAt } from './_shared';
import { users } from './identity';
import { orgs } from './orgs';

/**
 * An org's Jira Cloud site (B-7). The API token is encrypted with the org's data key, like AI keys.
 * Only the site's name is stored (acme → acme.atlassian.net), never a URL. `webhookToken` is the
 * secret in the URL Jira calls back on (Jira Cloud webhooks aren't signed).
 */
export const jiraConnections = pgTable('jira_connections', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  site: text('site').notNull(),
  email: text('email').notNull(),
  tokenEnc: bytea('token_enc').notNull(),
  dataKeyVersion: integer('data_key_version').notNull(),
  tokenLast4: text('token_last4').notNull(),
  /** Where "Create Jira issue" files new issues. */
  defaultProject: text('default_project'),
  webhookToken: text('webhook_token').notNull(),
  lastError: text('last_error'),
  lastSyncedAt: tsz('last_synced_at'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
