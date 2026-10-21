import { and, eq, schema, sql, type SystemDb } from '@autodev/db';
import { words, type Embedder } from './embedder';
import { codeIndexEnabled } from './indexer';

const { codeChunks, codeIndexState, orgs } = schema;

export interface CodeHit {
  path: string;
  startLine: number;
  endLine: number;
  symbol: string | null;
  content: string;
  score: number;
}

/** Candidates taken from each search before they are merged. */
const CANDIDATES = 40;
/** Reciprocal rank fusion constant: higher flattens the difference between ranks. */
const RRF_K = 60;

/** Words that match nearly everything in a keyword search over code or questions about it. */
const STOP = new Set(
  'a an and are as at be by can do does for from how i in is it of on or the this to what when where which who why with'.split(' '),
);

/**
 * Hybrid search over one repo's chunks: nearest vectors (meaning) and full-text matches (exact
 * names), merged by reciprocal rank fusion, so a query finds code by what it does or by what it's
 * called. The caller must have checked the asker can read the repo.
 */
export async function hybridSearch(
  sys: SystemDb,
  args: { orgId: string; repoId: string; query: string; vector: number[]; limit: number },
): Promise<CodeHit[]> {
  const terms = [...new Set(words(args.query))].filter((w) => !STOP.has(w)).slice(0, 32);
  const columns = {
    id: codeChunks.id,
    path: codeChunks.path,
    startLine: codeChunks.startLine,
    endLine: codeChunks.endLine,
    symbol: codeChunks.symbol,
    content: codeChunks.content,
  };
  const inRepo = and(eq(codeChunks.orgId, args.orgId), eq(codeChunks.repoId, args.repoId));

  const [byMeaning, byWords] = await sys.transaction(async (tx) => {
    // The HNSW index is shared by every repo; keep scanning until enough of this repo's rows are found.
    await tx.execute(sql`SET LOCAL hnsw.ef_search = 200`);
    await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    const vec = sql`${JSON.stringify(args.vector)}::vector`;
    const meaning = await tx
      .select(columns)
      .from(codeChunks)
      .where(inRepo)
      .orderBy(sql`${codeChunks.embedding} <=> ${vec}`)
      .limit(CANDIDATES);
    if (terms.length === 0) return [meaning, []] as const;
    // Terms are only [a-z0-9_], so they are safe inside a tsquery.
    const q = sql`to_tsquery('simple', ${terms.join(' | ')})`;
    const keyword = await tx
      .select(columns)
      .from(codeChunks)
      .where(and(inRepo, sql`${codeChunks.tsv} @@ ${q}`))
      .orderBy(sql`ts_rank_cd(${codeChunks.tsv}, ${q}) desc`)
      .limit(CANDIDATES);
    return [meaning, keyword] as const;
  });

  const scored = new Map<string, CodeHit>();
  for (const list of [byMeaning, byWords]) {
    list.forEach((row, rank) => {
      const hit = scored.get(row.id) ?? { path: row.path, startLine: row.startLine, endLine: row.endLine, symbol: row.symbol, content: row.content, score: 0 };
      hit.score += 1 / (RRF_K + rank + 1);
      scored.set(row.id, hit);
    });
  }
  return [...scored.values()].sort((a, b) => b.score - a.score).slice(0, args.limit);
}

/** What repo chat asks the index. Null means "no index here": chat falls back to GitHub search. */
export interface CodeSearch {
  search(orgId: string, repoId: string, query: string, limit?: number): Promise<{ commitSha: string; hits: CodeHit[] } | null>;
}

export class IndexedCodeSearch implements CodeSearch {
  constructor(private readonly deps: { sys: SystemDb; embedder: Embedder }) {}

  async search(orgId: string, repoId: string, query: string, limit = 10) {
    const [row] = await this.deps.sys
      .select({ commitSha: codeIndexState.commitSha, model: codeIndexState.model, settings: orgs.settings })
      .from(codeIndexState)
      .innerJoin(orgs, eq(orgs.id, codeIndexState.orgId))
      .where(and(eq(codeIndexState.orgId, orgId), eq(codeIndexState.repoId, repoId)));
    // Until a first run finishes (or after a model change) the chunks can't answer for the repo.
    if (!row?.commitSha || row.model !== this.deps.embedder.model || !codeIndexEnabled(row.settings)) return null;
    const [vector] = await this.deps.embedder.embed([query]);
    return { commitSha: row.commitSha, hits: await hybridSearch(this.deps.sys, { orgId, repoId, query, vector: vector!, limit }) };
  }
}
