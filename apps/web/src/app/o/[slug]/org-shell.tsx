'use client';

import { Badge, cn } from '@autodev/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { NotificationsBell } from '@/components/notifications-bell';
import { setCurrentOrgId, trpc, type RouterOutputs } from '@/lib/trpc';

type Membership = RouterOutputs['me']['get']['orgs'][number];
const OrgContext = createContext<Membership | null>(null);

export function useOrg(): Membership {
  const org = useContext(OrgContext);
  if (!org) throw new Error('useOrg must be used inside OrgShell');
  return org;
}

const NAV = [
  { href: 'tasks', label: 'Tasks' },
  { href: 'repos', label: 'Repositories' },
  { href: 'members', label: 'Members' },
  { href: 'builders', label: 'Builders' },
  { href: 'usage', label: 'Usage' },
  { href: 'settings', label: 'Settings' },
];

export function OrgShell({ slug, signOut, children }: { slug: string; signOut: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const me = trpc.me.get.useQuery();
  const org = me.data?.orgs.find((o) => o.slug === slug) ?? null;
  // Set synchronously during render, so the children's first queries already carry x-org-id.
  const [boundOrg, setBoundOrg] = useState<string | null>(null);
  if (org && boundOrg !== org.orgId) {
    // Query keys don't include the org, so drop org-scoped cache from the previous org.
    if (boundOrg) queryClient.removeQueries({ predicate: (q) => JSON.stringify(q.queryKey[0]) !== '["me","get"]' });
    setCurrentOrgId(org.orgId);
    setBoundOrg(org.orgId);
  }

  if (me.isLoading) return <p className="p-8 text-sm text-muted-foreground">Loading…</p>;
  if (!org) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-xl font-semibold">Organization not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You aren’t a member of “{slug}”, or it doesn’t exist.{' '}
          <Link href="/orgs" className="underline">
            Back to your organizations
          </Link>
        </p>
      </main>
    );
  }

  return (
    <OrgContext.Provider value={org}>
      <div className="min-h-screen">
        <header className="border-b">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/orgs" className="font-semibold">
              AutoDev
            </Link>
            <span className="text-sm">
              {org.name} <Badge variant="outline">{org.role}</Badge>
            </span>
            <nav className="flex gap-1 text-sm">
              {NAV.map((n) => {
                const href = `/o/${slug}/${n.href}`;
                return (
                  <Link
                    key={n.href}
                    href={href}
                    className={cn(
                      'rounded-md px-3 py-1.5 hover:bg-muted',
                      pathname.startsWith(href) && 'bg-muted font-medium',
                    )}
                  >
                    {n.label}
                  </Link>
                );
              })}
            </nav>
            <div className="ml-auto flex items-center gap-1">
              <NotificationsBell slug={slug} />
              {signOut}
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      </div>
    </OrgContext.Provider>
  );
}
