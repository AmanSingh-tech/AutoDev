'use client';

import { cn } from '@autodev/ui';
import { Bot, Building2, ChartColumn, CreditCard, FileText, KeyRound, Link2, ShieldCheck, SlidersHorizontal, Sparkles, Ticket, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const GROUPS: { label: string; items: { href: string; label: string; icon: LucideIcon }[] }[] = [
  { label: 'Organization', items: [{ href: '', label: 'General', icon: Building2 }] },
  {
    label: 'AI',
    items: [
      { href: '/ai-keys', label: 'AI keys', icon: KeyRound },
      { href: '/models', label: 'Models & prices', icon: Sparkles },
      { href: '/budgets', label: 'Budgets', icon: SlidersHorizontal },
      { href: '/templates', label: 'Task templates', icon: FileText },
    ],
  },
  {
    label: 'Features',
    items: [
      { href: '/insights', label: 'Insights', icon: ChartColumn },
      { href: '/group-agent', label: 'Group Agent', icon: Bot },
      { href: '/links', label: 'Linked repositories', icon: Link2 },
      { href: '/jira', label: 'Jira', icon: Ticket },
    ],
  },
  {
    label: 'Security & billing',
    items: [
      { href: '/security', label: 'Security', icon: ShieldCheck },
      { href: '/billing', label: 'Billing', icon: CreditCard },
    ],
  },
];

/** Settings: a grouped menu beside the page on wide screens, a sideways-scrolling row on phones. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { slug } = useParams<{ slug: string }>();
  const pathname = usePathname();
  const base = `/o/${slug}/settings`;
  return (
    <div className="lg:grid lg:grid-cols-[13rem_1fr] lg:gap-10">
      <nav aria-label="Settings" className="no-scrollbar -mx-4 mb-6 flex gap-1 overflow-x-auto border-b px-4 pb-2 lg:sticky lg:top-20 lg:mx-0 lg:mb-0 lg:block lg:space-y-5 lg:self-start lg:border-0 lg:px-0 lg:pb-0">
        {GROUPS.map((g) => (
          <div key={g.label} className="contents lg:block">
            <div className="hidden px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80 lg:block">{g.label}</div>
            <ul className="contents lg:block lg:space-y-0.5">
              {g.items.map((t) => {
                const href = base + t.href;
                const active = t.href ? pathname.startsWith(href) : pathname === base;
                return (
                  <li key={t.href} className="shrink-0">
                    <Link
                      href={href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors',
                        active ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                      )}
                    >
                      <t.icon aria-hidden className={cn('hidden size-4 lg:block', active ? 'text-primary' : 'text-muted-foreground')} />
                      {t.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
