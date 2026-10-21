import { createHash } from 'node:crypto';
import { CODE_EMBEDDING_DIMS } from '@autodev/db';

/**
 * Turns text into vectors for the index. Behind an interface so a hosted model (Voyage) can be
 * added later; the index stores `model` per repo, and a different model means a full re-index.
 */
export interface Embedder {
  readonly model: string;
  readonly dims: number;
  /** One unit-length vector per text, in order. */
  embed(texts: string[]): Promise<number[][]>;
}

export const LOCAL_EMBEDDING_MODEL = 'jinaai/jina-embeddings-v2-base-code';
/** Eight chunks of the largest size peak under 1 GB of worker memory. */
const BATCH = 8;
/** A safety cap on what is embedded: chunks are smaller, but a query or a future caller might not be. */
const MAX_TEXT_CHARS = 2000;

type Extractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

/**
 * `jina-embeddings-v2-base-code` (8-bit) run in-process with transformers.js. The model (about
 * 160 MB) is downloaded on first use into `cacheDir`. No code leaves the worker.
 */
export class LocalEmbedder implements Embedder {
  readonly model = LOCAL_EMBEDDING_MODEL;
  readonly dims = CODE_EMBEDDING_DIMS;
  private extractor?: Promise<Extractor>;
  /** One batch at a time: the model already uses every core, and this keeps memory flat. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: { cacheDir?: string } = {}) {}

  private load() {
    this.extractor ??= (async () => {
      const { env, pipeline } = await import('@huggingface/transformers');
      if (this.opts.cacheDir) env.cacheDir = this.opts.cacheDir;
      return (await pipeline('feature-extraction', this.model, { dtype: 'q8' })) as unknown as Extractor;
    })();
    return this.extractor;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out = new Array<number[]>(texts.length);
    // Similar lengths share a batch, so short texts aren't padded to the longest one.
    const order = texts.map((_, i) => i).sort((a, b) => texts[a]!.length - texts[b]!.length);
    for (let i = 0; i < order.length; i += BATCH) {
      const idx = order.slice(i, i + BATCH);
      const batch = idx.map((j) => texts[j]!.slice(0, MAX_TEXT_CHARS));
      const run = this.queue.then(async () => (await (await this.load())(batch, { pooling: 'mean', normalize: true })).tolist());
      this.queue = run.catch(() => undefined);
      const vectors = await run;
      idx.forEach((j, k) => (out[j] = vectors[k]!));
    }
    return out;
  }
}

/**
 * Deterministic stand-in for tests: a hashed bag of words, so texts that share identifiers are
 * close and unrelated ones are not. No model download.
 */
export class FakeEmbedder implements Embedder {
  readonly model = 'fake-bag-of-words';
  readonly dims = CODE_EMBEDDING_DIMS;
  calls = 0;

  async embed(texts: string[]): Promise<number[][]> {
    this.calls += texts.length;
    return texts.map((t) => {
      const v = new Array<number>(this.dims).fill(0);
      for (const w of words(t)) {
        const h = createHash('sha1').update(w).digest();
        v[h.readUInt16BE(0) % this.dims]! += 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}

/** Lower-case words, with camelCase and snake_case identifiers split into their parts too. */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z0-9_]+/g) ?? []) {
    out.push(raw.toLowerCase());
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_]+/)
      .filter(Boolean);
    if (parts.length > 1) for (const p of parts) out.push(p.toLowerCase());
  }
  return out;
}
