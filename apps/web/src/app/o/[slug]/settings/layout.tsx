'use client';

import { cn } from '@autodev/ui';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const TABS = [
  { href: '', label: 'General' },
  { href: '/ai-keys', label: 'AI keys' },
  { href: '/models', label: 'Models & prices' },
  { href: '/budgets', label: 'Budgets' },
  { href: '/templates', label: 'Task templates' },
  { href: '/insights', label: 'Insights' },
  { href: '/group-agent', label: 'Group Agent' },
  { href: '/links', label: 'Linked repositories' },
  { href: '/jira', label: 'Jira' },
  { href: '/security', label: 'Security' },
  { href: '/billing', label: 'Billing' },
];

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { slug } = useParams<{ slug: string }>();
  const pathname = usePathname();
  const base = `/o/${slug}/settings`;
  return (
    <div className="space-y-6">
      <nav className="no-scrollbar flex gap-1 overflow-x-auto whitespace-nowrap border-b pb-2 text-sm" aria-label="Settings">
        {TABS.map((t) => {
          const href = base + t.href;
          const active = t.href ? pathname.startsWith(href) : pathname === base;
          return (
            <Link key={t.href} href={href} className={cn('rounded-md px-3 py-1.5 hover:bg-muted', active && 'bg-muted font-medium')}>
              {t.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
