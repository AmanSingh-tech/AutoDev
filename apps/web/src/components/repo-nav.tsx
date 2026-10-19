'use client';

import { cn } from '@autodev/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '', label: 'Board' },
  { href: '/room', label: 'Team room' },
  { href: '/chat', label: 'Ask the repo' },
  { href: '/agent', label: 'Repo Agent' },
];

/** Tabs across a repo's pages. */
export function RepoNav({ slug, name, fullName }: { slug: string; name: string; fullName?: string }) {
  const pathname = usePathname();
  const base = `/o/${slug}/repos/${name}`;
  return (
    <div className="space-y-2">
      {fullName && <p className="text-sm text-muted-foreground">{fullName}</p>}
      <nav className="no-scrollbar flex gap-1 overflow-x-auto whitespace-nowrap border-b pb-2 text-sm" aria-label="Repository">
        {TABS.map((t) => {
          const href = base + t.href;
          const active = t.href ? pathname.startsWith(href) : pathname === base;
          return (
            <Link key={t.href} href={href} aria-current={active ? 'page' : undefined} className={cn('rounded-md px-3 py-1.5 hover:bg-muted', active && 'bg-muted font-medium')}>
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
