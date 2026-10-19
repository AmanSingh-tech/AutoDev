import {
  EVENT_TOPIC_KINDS,
  eventPayloads,
  topicKindOf,
  type EventEnvelope,
  type EventPayload,
  type EventType,
} from '@autodev/protocol';
import type { Redis } from 'ioredis';
import { publishEvent } from './bus';

export interface TypedEvent<T extends EventType = EventType> {
  type: T;
  orgId: string;
  topic: string;
  payload: EventPayload<T>;
}

/**
 * Publishes a catalogue event. The payload is checked against its schema and the topic against the
 * kinds the event may use, so a wrong event fails here instead of reaching a browser.
 */
export async function emit<T extends EventType>(
  redis: Redis,
  e: TypedEvent<T>,
  now?: Date,
): Promise<EventEnvelope> {
  const kind = topicKindOf(e.topic);
  if (!kind || !EVENT_TOPIC_KINDS[e.type].includes(kind))
    throw new Error(`${e.type} can't be sent on ${e.topic}`);
  const payload = eventPayloads[e.type].parse(e.payload) as Record<string, unknown>;
  return publishEvent(redis, { type: e.type, topic: e.topic, orgId: e.orgId, payload }, now);
}
