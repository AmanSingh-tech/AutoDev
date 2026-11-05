'use client';

import { cn } from '@autodev/ui';
import { ArrowRight, Building2, CornerDownLeft, CreditCard, KeyRound, Search, Shield, SlidersHorizontal, Sparkles, Ticket, type LucideIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { hrefFor, navGroups, type NavAccess } from './nav';

interface Command {
  id: string;
  label: string;
  group: string;
  href: string;
  icon: LucideIcon;
  keywords?: string;
}

function commands(slug: string, access: NavAccess | undefined): Command[] {
  const nav = navGroups(access).flatMap((g) => g.items.map((i) => ({ id: `nav:${i.href}`, label: i.label, group: 'Go to', href: hrefFor(slug, i), icon: i.icon })));
  const s = (path: string) => `/o/${slug}/settings${path}`;
  const settings: Command[] = [
    { id: 'set:ai', label: 'AI keys', group: 'Settings', href: s('/ai-keys'), icon: KeyRound, keywords: 'anthropic openai api key' },
    { id: 'set:models', label: 'Models & prices', group: 'Settings', href: s('/models'), icon: Sparkles, keywords: 'model price policy' },
    { id: 'set:budgets', label: 'Budgets', group: 'Settings', href: s('/budgets'), icon: SlidersHorizontal, keywords: 'limit spend' },
    { id: 'set:security', label: 'Security', group: 'Settings', href: s('/security'), icon: Shield, keywords: 'sso ip allowlist retention audit siem' },
    { id: 'set:billing', label: 'Billing', group: 'Settings', href: s('/billing'), icon: CreditCard, keywords: 'plan invoice stripe seats' },
    { id: 'set:jira', label: 'Jira', group: 'Settings', href: s('/jira'), icon: Ticket, keywords: 'issue atlassian' },
  ];
  return [...nav, ...settings, { id: 'orgs', label: 'All organizations', group: 'Go to', href: '/orgs?pick=1', icon: Building2, keywords: 'switch' }];
}

/** ⌘K / Ctrl+K: jump to any page by typing. Arrow keys move, Enter opens, Escape closes. */
export function CommandPalette({ slug, access, open, onOpenChange }: { slug: string; access: NavAccess | undefined; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const all = useMemo(() => commands(slug, access), [slug, access]);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? all.filter((c) => `${c.label} ${c.group} ${c.keywords ?? ''}`.toLowerCase().includes(q)) : all;
  }, [all, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);
  useEffect(() => setActive(0), [query]);

  if (!open) return null;
  const go = (c: Command | undefined) => {
    if (!c) return;
    onOpenChange(false);
    router.push(c.href);
  };
  let lastGroup = '';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/20 px-4 pt-[12vh] backdrop-blur-[2px] animate-fade" onMouseDown={() => onOpenChange(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Go to"
        className="w-full max-w-lg overflow-hidden rounded-xl border bg-popover shadow-pop animate-enter"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-3">
          <Search aria-hidden className="size-4 text-muted-foreground" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, results.length - 1)));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
              else if (e.key === 'Enter') (e.preventDefault(), go(results[active]));
              else if (e.key === 'Escape') onOpenChange(false);
            }}
            placeholder="Go to a page…"
            aria-label="Search pages"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-results"
            aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">Esc</kbd>
        </div>
        <ul id="command-results" role="listbox" className="max-h-80 overflow-y-auto p-1.5">
          {results.length === 0 && <li className="px-3 py-8 text-center text-sm text-muted-foreground">No pages match “{query}”.</li>}
          {results.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <li key={c.id} role="presentation">
                {header && <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{header}</div>}
                <div
                  id={`cmd-${c.id}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => go(c)}
                  className={cn('flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm', i === active && 'bg-accent text-accent-foreground')}
                >
                  <c.icon aria-hidden className="size-4 shrink-0 opacity-70" />
                  <span className="flex-1">{c.label}</span>
                  {i === active ? <CornerDownLeft aria-hidden className="size-3.5 opacity-60" /> : <ArrowRight aria-hidden className="size-3.5 opacity-0" />}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
