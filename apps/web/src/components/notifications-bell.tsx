'use client';

import { Button } from '@autodev/ui';
import { Bell } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { relativeTime } from '@/lib/format';
import { trpc } from '@/lib/trpc';
import { useEvents } from '@/lib/use-events';

/** Notification links are stored org-relative ("/settings/ai-keys"); this prefixes the current org. */
export function NotificationsBell({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const utils = trpc.useUtils();
  const q = trpc.notifications.list.useQuery(undefined, { refetchInterval: 60_000 });
  // New notifications arrive on the user's own topic; the poll stays as a fallback.
  const me = trpc.me.get.useQuery();
  const orgId = me.data?.orgs.find((o) => o.slug === slug)?.orgId ?? '';
  useEvents(orgId, orgId && me.data?.user ? [`user:${me.data.user.id}`] : [], (events) => {
    if (events.some((e) => e.type === 'notification')) void utils.notifications.list.invalidate();
  });
  const markRead = trpc.notifications.markRead.useMutation({ onSuccess: () => utils.notifications.list.invalidate() });

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const unread = q.data?.unread ?? 0;
  return (
    <div ref={ref} className="relative">
      <Button variant="ghost" size="icon" className="relative" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Bell aria-hidden />
        <span className="sr-only">Notifications{unread > 0 ? ` (${unread} unread)` : ''}</span>
        {unread > 0 && (
          <span aria-hidden className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground ring-2 ring-background">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </Button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] origin-top-right animate-enter overflow-hidden rounded-xl border bg-popover shadow-pop">
          <div className="flex items-center justify-between border-b px-3 py-2 text-sm font-medium">
            Notifications
            {unread > 0 && (
              <button className="text-xs text-muted-foreground hover:underline" onClick={() => markRead.mutate({})}>
                Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {q.data?.items.map((n) => {
              const body = (
                <>
                  <div className={n.readAt ? 'text-muted-foreground' : 'font-medium'}>{n.title}</div>
                  {n.body && <div className="text-xs text-muted-foreground">{n.body}</div>}
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{relativeTime(n.createdAt)}</div>
                </>
              );
              return (
                <li key={n.id} className="border-b px-3 py-2 text-sm last:border-0">
                  {n.link ? (
                    <Link href={`/o/${slug}${n.link}`} onClick={() => (setOpen(false), !n.readAt && markRead.mutate({ ids: [n.id] }))}>
                      {body}
                    </Link>
                  ) : (
                    body
                  )}
                </li>
              );
            })}
            {q.data?.items.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing yet.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
