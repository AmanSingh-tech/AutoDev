import { boolean, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { bytea, createdAt, tsz, updatedAt } from './_shared';
import { orgs } from './orgs';

/**
 * Where an org's audit log is streamed (B-7): an HTTPS endpoint that receives signed NDJSON
 * batches. The signing secret is encrypted with the org's data key, like AI keys. The worker
 * keeps a cursor (created_at, id) so each entry is sent once, in order.
 */
export const siemDestinations = pgTable('siem_destinations', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  secretEnc: bytea('secret_enc').notNull(),
  dataKeyVersion: integer('data_key_version').notNull(),
  secretLast4: text('secret_last4').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  cursorCreatedAt: tsz('cursor_created_at'),
  cursorId: uuid('cursor_id'),
  lastSentAt: tsz('last_sent_at'),
  lastError: text('last_error'),
  failures: integer('failures').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
