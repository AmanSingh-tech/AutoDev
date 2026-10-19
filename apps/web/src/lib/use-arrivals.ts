'use client';

import { useRef } from 'react';

/**
 * Which of `ids` arrived after the list first loaded. Only those get an entrance animation: the
 * initial list appears at once (animating 100 messages on page load is noise, not information).
 * `scope` names the list (a chat id, a room); a new scope starts over, so switching chats doesn't
 * animate the whole conversation.
 */
export function useArrivals(ids: readonly string[] | undefined, scope: string): (id: string) => boolean {
  const state = useRef<{ scope: string; initial: Set<string> } | null>(null);
  if (ids && state.current?.scope !== scope) state.current = { scope, initial: new Set(ids) };
  return (id) => state.current !== null && state.current.scope === scope && !state.current.initial.has(id);
}
