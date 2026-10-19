'use client';

import type { AppEvent } from '@autodev/protocol';
import { useEffect, useRef } from 'react';

/** Events that arrive within this window are handed over together, so a burst causes one refetch. */
const BATCH_MS = 250;
/** Topic changes within this window (several components mounting) reopen the stream once. */
const REOPEN_MS = 50;

interface Subscriber {
  topics: Set<string>;
  deliver: (events: AppEvent[]) => void;
}

/**
 * The tab's single event stream. Every useEvents() caller registers its topics here; the stream is
 * opened for their union and reopened when that changes. A reopen passes the last event id, so
 * the server replays anything sent while the topic set was being changed.
 */
class TabStream {
  private readonly subs = new Set<Subscriber>();
  private source: EventSource | null = null;
  private openKey = '';
  private lastEventId: string | null = null;
  private reopenTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly orgId: string) {}

  add(sub: Subscriber) {
    this.subs.add(sub);
    this.scheduleReopen();
    return () => {
      this.subs.delete(sub);
      this.scheduleReopen();
    };
  }

  private scheduleReopen() {
    clearTimeout(this.reopenTimer);
    this.reopenTimer = setTimeout(() => this.reopen(), REOPEN_MS);
  }

  private reopen() {
    const topics = [...new Set([...this.subs].flatMap((s) => [...s.topics]))].sort();
    const key = topics.join(',');
    if (key === this.openKey) return;
    this.source?.close();
    this.source = null;
    this.openKey = key;
    if (!key || typeof EventSource === 'undefined') return;

    const params = new URLSearchParams({ org: this.orgId, topics: key });
    if (this.lastEventId) params.set('lastEventId', this.lastEventId);
    const source = new EventSource(`/api/events?${params}`);
    source.onmessage = (m) => {
      let event: AppEvent;
      try {
        event = JSON.parse(m.data) as AppEvent;
      } catch {
        return;
      }
      this.lastEventId = m.lastEventId || this.lastEventId;
      for (const sub of this.subs) if (sub.topics.has(event.topic)) sub.deliver([event]);
    };
    this.source = source;
  }
}

const streams = new Map<string, TabStream>();
const streamFor = (orgId: string) => {
  let s = streams.get(orgId);
  if (!s) streams.set(orgId, (s = new TabStream(orgId)));
  return s;
};

/**
 * Calls `onEvents` with events on the given topics (packages/protocol/src/events.ts). All callers
 * in a tab share one stream. An empty topic list means "not yet": nothing is subscribed.
 */
export function useEvents(orgId: string, topics: string[], onEvents: (events: AppEvent[]) => void) {
  const latest = useRef(onEvents);
  useEffect(() => {
    latest.current = onEvents;
  });

  const key = [...new Set(topics)].sort().join(',');
  useEffect(() => {
    if (!key) return;
    let batch: AppEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remove = streamFor(orgId).add({
      topics: new Set(key.split(',')),
      deliver: (events) => {
        batch.push(...events);
        clearTimeout(timer);
        timer = setTimeout(() => {
          const ready = batch;
          batch = [];
          latest.current(ready);
        }, BATCH_MS);
      },
    });
    return () => {
      clearTimeout(timer);
      remove();
    };
  }, [orgId, key]);
}
