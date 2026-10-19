import { EventEmitter } from 'node:events';
import { eventEnvelope, type EventEnvelope } from '@autodev/protocol';
import type { Redis } from 'ioredis';

/**
 * Event transport. Each org has a Redis stream (history, for replay after a reconnect) and a
 * pub/sub channel (live fan-out to every API process). Publishers can be the API, the worker or
 * the builder gateway; subscribers are the SSE streams in the API.
 */
export const STREAM_MAX_LEN = 10_000;
export const streamKey = (orgId: string) => `events:org:${orgId}`;
export const liveChannel = (orgId: string) => `events:live:${orgId}`;

export interface NewEvent {
  type: string;
  topic: string;
  orgId: string;
  payload: Record<string, unknown>;
}

/** Stores the event in the org's stream, then publishes it live. Returns the stored envelope. */
export async function publishEvent(
  redis: Redis,
  e: NewEvent,
  now = new Date(),
): Promise<EventEnvelope> {
  const body = {
    type: e.type,
    topic: e.topic,
    orgId: e.orgId,
    ts: now.toISOString(),
    payload: e.payload,
  };
  const id = await redis.xadd(
    streamKey(e.orgId),
    'MAXLEN',
    '~',
    STREAM_MAX_LEN,
    '*',
    'e',
    JSON.stringify(body),
  );
  if (!id) throw new Error('XADD returned no id');
  const env = eventEnvelope.parse({ id, ...body });
  await redis.publish(liveChannel(e.orgId), JSON.stringify(env));
  return env;
}

/** Stream ids are `<ms>-<seq>`. Anything else from a client is ignored, not trusted. */
export const STREAM_ID = /^\d+-\d+$/;

/** Events after `afterId` (exclusive), oldest first. Only what is still inside the stream's window. */
export async function replayAfter(
  redis: Redis,
  orgId: string,
  afterId: string | null,
  count = 1000,
): Promise<EventEnvelope[]> {
  const start = afterId && STREAM_ID.test(afterId) ? `(${afterId}` : '-';
  const rows = await redis.xrange(streamKey(orgId), start, '+', 'COUNT', count);
  return rows.map(([id, fields]) =>
    eventEnvelope.parse({ id, ...JSON.parse(fields[1] ?? 'null') }),
  );
}

/** True when stream id `a` comes after stream id `b`. */
export function isAfter(a: string, b: string): boolean {
  const [am, as] = a.split('-').map(Number) as [number, number];
  const [bm, bs] = b.split('-').map(Number) as [number, number];
  return am !== bm ? am > bm : as > bs;
}

/**
 * Live events for any number of org streams over one Redis subscriber connection. A subscription
 * resolves only once the channel is confirmed, so a replay that follows it misses nothing.
 */
export class EventHub {
  private readonly emitter = new EventEmitter();
  private readonly counts = new Map<string, number>();

  constructor(private readonly sub: Redis) {
    this.emitter.setMaxListeners(0);
    sub.on('message', (channel: string, message: string) => {
      if (!channel.startsWith('events:live:')) return;
      const orgId = channel.slice('events:live:'.length);
      let env: EventEnvelope;
      try {
        env = eventEnvelope.parse(JSON.parse(message));
      } catch {
        return;
      }
      this.emitter.emit(`org:${orgId}`, env);
    });
  }

  async subscribe(orgId: string, onEvent: (env: EventEnvelope) => void): Promise<() => void> {
    const event = `org:${orgId}`;
    const count = this.counts.get(orgId) ?? 0;
    this.counts.set(orgId, count + 1);
    if (count === 0) await this.sub.subscribe(liveChannel(orgId));
    this.emitter.on(event, onEvent);
    return () => {
      this.emitter.off(event, onEvent);
      const left = (this.counts.get(orgId) ?? 1) - 1;
      if (left <= 0) {
        this.counts.delete(orgId);
        void this.sub.unsubscribe(liveChannel(orgId));
      } else {
        this.counts.set(orgId, left);
      }
    };
  }

  async close() {
    this.emitter.removeAllListeners();
    this.counts.clear();
    this.sub.disconnect();
  }
}
