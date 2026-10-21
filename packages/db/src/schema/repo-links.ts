import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './_shared';
import { users } from './identity';
import { orgs } from './orgs';
import { repos } from './repos';

/**
 * Cross-repo sync (B-3): a change in `source` can be applied to `target` as a new task. Two-way
 * links work in both directions. One link per pair of repos, whichever way round. Members see links
 * of repos they can access (RLS, migration 0025); only admins change them (API).
 */
export const repoLinks = pgTable(
  'repo_links',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    sourceRepoId: uuid('source_repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    targetRepoId: uuid('target_repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    twoWay: boolean('two_way').notNull().default(false),
    /** How the repos map onto each other, for the agent ("web/src/api/* ↔ mobile/lib/api/*"). */
    mappingNotesMd: text('mapping_notes_md').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('repo_links_pair_uq').on(sql`least(${t.sourceRepoId}, ${t.targetRepoId})`, sql`greatest(${t.sourceRepoId}, ${t.targetRepoId})`),
    index('repo_links_target_idx').on(t.targetRepoId),
    check('repo_links_not_self', sql`${t.sourceRepoId} <> ${t.targetRepoId}`),
    check('repo_links_notes_length', sql`char_length(${t.mappingNotesMd}) <= 8000`),
  ],
);
