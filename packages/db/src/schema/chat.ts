import { index, jsonb, pgTable, text, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { createdAt, id, tsz, updatedAt } from './_shared';
import { chatMessageStatus, chatRole } from './enums';
import { users } from './identity';
import { orgs } from './orgs';
import { repos } from './repos';

/** A private chat about one repo. Only its author can read it (RLS, migration 0015). */
export const repoChats = pgTable(
  'repo_chats',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('repo_chats_owner_idx').on(t.orgId, t.userId, t.repoId, t.updatedAt)],
);

/**
 * User questions and assistant answers. An assistant row starts `pending` with `replyToId` set to
 * the question it answers, and the worker fills in `content`, `sources` and `status`.
 */
export const repoChatMessages = pgTable(
  'repo_chat_messages',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => repoChats.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: chatRole('role').notNull(),
    status: chatMessageStatus('status').notNull().default('done'),
    content: text('content').notNull().default(''),
    replyToId: uuid('reply_to_id').references((): AnyPgColumn => repoChatMessages.id, {
      onDelete: 'set null',
    }),
    /** Repo paths the answer read, shown under it so people can check the claims. */
    sources: jsonb('sources').$type<string[]>().notNull().default([]),
    error: text('error'),
    createdAt: createdAt(),
    completedAt: tsz('completed_at'),
  },
  (t) => [index('repo_chat_messages_chat_idx').on(t.chatId, t.createdAt)],
);
