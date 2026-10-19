import { EventEmitter } from 'node:events';
import postgres from 'postgres';

/** The channel the notify_task_change() trigger writes to (migration 0013). */
export const TASK_CHANGES_CHANNEL = 'task_changes';

/**
 * One Postgres LISTEN connection per API process, shared by every open SSE stream.
 * It connects on the first subscription, so tests and idle processes never open it.
 * Notifications are sent on commit, so a listener never sees a change before it can be read.
 */
export class TaskChangeHub {
  private readonly emitter = new EventEmitter();
  private client: postgres.Sql | null = null;
  private listening: Promise<unknown> = Promise.resolve();

  constructor(private readonly url: string) {
    this.emitter.setMaxListeners(0);
  }

  /** Calls `onChange` with the task id whenever a task in `orgId` changes. Returns the unsubscribe. */
  subscribe(orgId: string, onChange: (taskId: string) => void): () => void {
    const event = `org:${orgId}`;
    const listener = (taskId: string) => onChange(taskId);
    this.emitter.on(event, listener);
    void this.ensureListening();
    return () => this.emitter.off(event, listener);
  }

  /** Resolves once the LISTEN is active, so a change made after this is delivered. */
  ready(): Promise<unknown> {
    return this.listening;
  }

  async close() {
    this.emitter.removeAllListeners();
    const client = this.client;
    this.client = null;
    await client?.end({ timeout: 5 });
  }

  private ensureListening() {
    if (!this.client) {
      this.client = postgres(this.url, { max: 1, onnotice: () => {} });
      this.listening = this.client.listen(TASK_CHANGES_CHANNEL, (payload) => this.dispatch(payload)).catch(() => {
        // Postgres.js reconnects on its own. Clients that missed events refetch when the stream reopens.
      });
    }
  }

  private dispatch(payload: string) {
    let change: { org_id?: unknown; task_id?: unknown };
    try {
      change = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof change.org_id !== 'string' || typeof change.task_id !== 'string') return;
    this.emitter.emit(`org:${change.org_id}`, change.task_id);
  }
}
