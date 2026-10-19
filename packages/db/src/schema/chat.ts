import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, unique, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { createdAt, id, tsz, updatedAt } from './_shared';
import { channelAuthor, chatMessageStatus, chatRole, memorySection } from './enums';
import { users } from './identity';
import { orgs } from './orgs';
import { repos } from './repos';

/** A place in the repo an answer relied on. Lines are 1-based and inclusive; absent means the whole file. */
export interface Citation {
  path: string;
  startLine?: number;
  endLine?: number;
}

/** A private chat about one repo. Only its author can read it (RLS, migrations 0015 and 0022). */
export const chatSessions = pgTable(
  'chat_sessions',
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
  (t) => [index('chat_sessions_owner_idx').on(t.orgId, t.userId, t.repoId, t.updatedAt)],
);

/**
 * User questions and assistant answers. An assistant row starts `pending` with `replyToId` set to
 * the question it answers, and the worker fills in `content`, `citations` and `status`.
 */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => chatSessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: chatRole('role').notNull(),
    status: chatMessageStatus('status').notNull().default('done'),
    content: text('content').notNull().default(''),
    replyToId: uuid('reply_to_id').references((): AnyPgColumn => chatMessages.id, {
      onDelete: 'set null',
    }),
    /** Where the answer looked, shown under it as links to GitHub at `commitSha`. */
    citations: jsonb('citations').$type<Citation[]>().notNull().default([]),
    /** The commit the answer read; citations link to the code as it was then. */
    commitSha: text('commit_sha'),
    error: text('error'),
    createdAt: createdAt(),
    completedAt: tsz('completed_at'),
  },
  (t) => [index('chat_messages_session_idx').on(t.sessionId, t.createdAt)],
);

/** The shared team room of one repo. Created on first use. */
export const repoChannels = pgTable(
  'repo_channels',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [unique('repo_channels_repo_uq').on(t.repoId)],
);

/**
 * Messages in a team room. People's messages are `done` at once. A message that mentions the Repo
 * Agent gets a `pending` agent message replying to it, which the worker answers. `userId` is the
 * person who wrote it, or for an agent message the person who mentioned the agent (whose key,
 * budget and GitHub access the answer used).
 */
export const channelMessages = pgTable(
  'channel_messages',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => repoChannels.id, { onDelete: 'cascade' }),
    /** Copied from the channel, so RLS and realtime routing need no join. */
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    author: channelAuthor('author').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: chatMessageStatus('status').notNull().default('done'),
    content: text('content').notNull().default(''),
    replyToId: uuid('reply_to_id').references((): AnyPgColumn => channelMessages.id, {
      onDelete: 'set null',
    }),
    citations: jsonb('citations').$type<Citation[]>().notNull().default([]),
    commitSha: text('commit_sha'),
    error: text('error'),
    createdAt: createdAt(),
    completedAt: tsz('completed_at'),
  },
  (t) => [index('channel_messages_channel_idx').on(t.channelId, t.createdAt)],
);

/**
 * What the Repo Agent knows about a repo beyond its code: one note per section, edited by people
 * with push access. Fed to repo chat and the Repo Agent (and later, to AI review).
 */
export const repoAgentMemory = pgTable(
  'repo_agent_memory',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    section: memorySection('section').notNull(),
    contentMd: text('content_md').notNull().default(''),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('repo_agent_memory_section_uq').on(t.repoId, t.section),
    check('repo_agent_memory_length', sql`char_length(${t.contentMd}) <= 8000`),
  ],
);
