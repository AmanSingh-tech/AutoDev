import { customType, index, integer, pgTable, text, uuid, vector } from 'drizzle-orm/pg-core';
import { createdAt, id, tsz, updatedAt } from './_shared';
import { codeIndexStatus } from './enums';
import { orgs } from './orgs';
import { repos } from './repos';

/** Written with `to_tsvector('simple', …)` by the indexer; never read back as a value. */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/** Dimensions of the embedding model (`jina-embeddings-v2-base-code`). A new model with other dimensions needs a migration. */
export const CODE_EMBEDDING_DIMS = 768;

/**
 * One piece of a file on a repo's default branch: a function, a class, or a window of lines.
 * Written only by the worker (system role); people read the chunks of repos they can access (RLS,
 * migration 0024). Stored only while the org's `storeCodeIndex` setting is on.
 */
export const codeChunks = pgTable(
  'code_chunks',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    /** The file's blob sha. An unchanged file keeps its chunks across commits. */
    blobSha: text('blob_sha').notNull(),
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
    language: text('language'),
    /** The function or class the chunk starts with, when the parser found one. */
    symbol: text('symbol'),
    content: text('content').notNull(),
    /** Keyword search: path, symbol, content and identifiers split into words. */
    tsv: tsvector('tsv').notNull(),
    embedding: vector('embedding', { dimensions: CODE_EMBEDDING_DIMS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('code_chunks_repo_path_idx').on(t.repoId, t.path),
    index('code_chunks_tsv_idx').using('gin', t.tsv),
    index('code_chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

/** Where each repo's index stands. One row per indexed repo; removed with the chunks when the setting is turned off. */
export const codeIndexState = pgTable('code_index_state', {
  repoId: uuid('repo_id')
    .primaryKey()
    .references(() => repos.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  status: codeIndexStatus('status').notNull().default('pending'),
  /** The commit the chunks describe. Null until the first run finishes. */
  commitSha: text('commit_sha'),
  /** The embedding model the chunks were made with. A different model means a full re-index. */
  model: text('model'),
  files: integer('files').notNull().default(0),
  chunks: integer('chunks').notNull().default(0),
  /** Files left out because the repo has more than the per-repo cap. */
  skippedFiles: integer('skipped_files').notNull().default(0),
  error: text('error'),
  startedAt: tsz('started_at'),
  finishedAt: tsz('finished_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
