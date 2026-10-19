import { emit, eventsForChange, type RowChange } from '@autodev/events';
import type { Redis } from 'ioredis';
import postgres from 'postgres';

/** The channel the notify_row_change() trigger writes to (migration 0020). */
export const ROW_CHANGES_CHANNEL = 'row_changes';
/** How long an event key is remembered, so each event is published only once. */
const DEDUPE_SECONDS = 300;

/**
 * Turns committed row changes into catalogue events (packages/events/src/changes.ts). Notices are
 * sent on commit, so an event never describes data a reader can't see yet. Every API process
 * listens; each event is published by whichever process claims its key first (SET NX).
 */
export class ChangeBridge {
  private client: postgres.Sql | null = null;

  constructor(private readonly deps: { databaseUrl: string; redis: Redis }) {}

  async start() {
    if (this.client) return;
    this.client = postgres(this.deps.databaseUrl, { max: 1, onnotice: () => {} });
    await this.client.listen(ROW_CHANGES_CHANNEL, (payload) => {
      void this.handle(payload).catch(() => {
        // A failed publish is not retried; clients fall back to their slow poll.
      });
    });
  }

  async close() {
    const client = this.client;
    this.client = null;
    await client?.end({ timeout: 5 });
  }

  /** Public for tests: handles one notice exactly as the listener would. Returns what it published. */
  async handle(payload: string) {
    let change: RowChange;
    try {
      change = JSON.parse(payload) as RowChange;
    } catch {
      return [];
    }
    const published = [];
    for (const { dedupe, ...event } of eventsForChange(change)) {
      const claimed = await this.deps.redis.set(
        `events:dedupe:${dedupe}`,
        '1',
        'EX',
        DEDUPE_SECONDS,
        'NX',
      );
      if (claimed !== 'OK') continue;
      published.push(await emit(this.deps.redis, event));
    }
    return published;
  }
}
