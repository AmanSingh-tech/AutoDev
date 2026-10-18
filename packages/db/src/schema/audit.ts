import { index, inet, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, tsz } from './_shared';
import { actorType } from './enums';
import { users } from './identity';
import { orgs } from './orgs';

/** In-app notifications (builder offline, key failures, budget alerts…). Email comes later. */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    readAt: tsz('read_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_unread_idx').on(t.userId, t.readAt, t.createdAt)],
);

/**
 * Append-only: the app role can only INSERT and SELECT, and a trigger rejects UPDATE/DELETE
 * for every role (see the rls migration). org_id is null only for events outside an org (e.g. login).
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'restrict' }),
    actorType: actorType('actor_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_log_org_created_idx').on(t.orgId, t.createdAt),
    index('audit_log_actor_idx').on(t.actorUserId, t.createdAt),
  ],
);
