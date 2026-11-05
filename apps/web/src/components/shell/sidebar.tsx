'use client';

import { cn } from '@autodev/ui';
import { Check, ChevronsUpDown, Monitor, Moon, Sun } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { trpc } from '@/lib/trpc';
import { hrefFor, isCurrent, navGroups, type NavAccess } from './nav';
import { applyTheme, readTheme, type ThemeChoice } from './theme';

/** A square with the org's first letter: the org's "logo" until it has one. */
export function OrgMark({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden className={cn('flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground', className)}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function AutoDevMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn('size-6', className)}>
      <rect width="24" height="24" rx="6" className="fill-primary" />
      <path d="M7 16.5 11.2 7h1.6l4.2 9.5M8.6 13h6.8" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="stroke-primary-foreground" />
    </svg>
  );
}

/** Everything inside the sidebar; the same content is used for the phone drawer. */
export function SidebarContent({
  slug,
  org,
  access,
  signOut,
  onNavigate,
}: {
  slug: string;
  org: { name: string; role: string; demo?: boolean };
  access: NavAccess | undefined;
  signOut: ReactNode;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pb-2 pt-3">
        <Link
          href="/orgs?pick=1"
          onClick={onNavigate}
          className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-secondary"
          title="Switch organization"
        >
          <OrgMark name={org.name} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold leading-tight">{org.name}</span>
            <span className="flex items-center gap-1.5 text-xs capitalize text-muted-foreground">
              {org.role}
              {org.demo && <span className="rounded-full bg-accent px-1.5 text-[10px] font-medium normal-case text-accent-foreground">Demo</span>}
            </span>
          </span>
          <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="sr-only">Switch organization</span>
        </Link>
      </div>

      <nav aria-label="Main" className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
        {navGroups(access).map((g, i) => (
          <div key={g.label ?? i}>
            {g.label && <div className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">{g.label}</div>}
            <ul className="space-y-0.5">
              {g.items.map((item) => {
                const current = isCurrent(pathname, slug, item);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={hrefFor(slug, item)}
                      onClick={onNavigate}
                      aria-current={current ? 'page' : undefined}
                      className={cn(
                        'group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                        current ? 'bg-card font-medium text-foreground shadow-xs ring-1 ring-border' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                      )}
                    >
                      <Icon aria-hidden className={cn('size-4 shrink-0', current ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t p-3">
        <UserMenu signOut={signOut} />
      </div>
    </div>
  );
}

const THEMES: { id: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
];

/** The signed-in person, with the theme choice and sign out. */
function UserMenu({ signOut }: { signOut: ReactNode }) {
  const me = trpc.me.get.useQuery();
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>('system');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setTheme(readTheme()), []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const user = me.data?.user;
  return (
    <div ref={ref} className="relative">
      {open && (
        <div role="menu" className="absolute bottom-full left-0 right-0 z-30 mb-2 origin-bottom animate-enter rounded-lg border bg-popover p-1 shadow-pop">
          <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Theme</div>
          {THEMES.map((t) => (
            <button
              key={t.id}
              role="menuitemradio"
              aria-checked={theme === t.id}
              onClick={() => (applyTheme(t.id), setTheme(t.id))}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-secondary"
            >
              <t.icon aria-hidden className="size-4 text-muted-foreground" />
              <span className="flex-1 text-left">{t.label}</span>
              {theme === t.id && <Check aria-hidden className="size-4 text-primary" />}
            </button>
          ))}
          <div className="my-1 border-t" />
          <Link href="/orgs?pick=1" role="menuitem" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-secondary">
            <ChevronsUpDown aria-hidden className="size-4 text-muted-foreground" />
            All organizations
          </Link>
          {signOut}
        </div>
      )}
      <button
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-secondary"
      >
        {user?.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.avatarUrl} alt="" className="size-7 rounded-full" />
        ) : (
          <span aria-hidden className="size-7 rounded-full bg-secondary" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium leading-tight">{user?.name ?? user?.githubLogin ?? '…'}</span>
          {user?.name && <span className="block truncate text-xs text-muted-foreground">@{user.githubLogin}</span>}
        </span>
        <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="sr-only">Account menu</span>
      </button>
    </div>
  );
}
