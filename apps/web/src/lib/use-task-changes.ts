'use client';

import { useEffect, useRef } from 'react';

/**
 * Calls `onChange` shortly after a task in `orgId` changes, using the API's event stream.
 * Several changes in a burst make one call. The stream reconnects on its own, and events sent
 * while it was down are lost, so `onChange` also runs after each reconnect.
 */
export function useTaskChanges(orgId: string, onChange: () => void) {
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let opened = false;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(() => latest.current(), 300);
    };
    const source = new EventSource(`/api/events/tasks?org=${encodeURIComponent(orgId)}`);
    source.addEventListener('task', fire);
    source.onopen = () => {
      if (opened) fire();
      opened = true;
    };
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [orgId]);
}
