'use client';

import { Badge, cn } from '@autodev/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { OrgBanner } from '@/components/billing-bits';
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

/** The nav, with Insights only for people who can open some of it and Group Agent for admins. */
function navFor(insights: { canSeeOverview: boolean; canSeeLeaderboard: boolean; isAdmin: boolean } | undefined) {
  const extra: { href: string; label: string }[] = [];
  if (insights && (insights.canSeeOverview || insights.canSeeLeaderboard)) extra.push({ href: insights.canSeeOverview ? 'insights' : 'insights/leaderboard', label: 'Insights' });
  if (insights?.isAdmin) extra.push({ href: 'group-agent', label: 'Group Agent' });
  const at = NAV.findIndex((n) => n.href === 'usage');
  return [...NAV.slice(0, at), ...extra, ...NAV.slice(at)];
}

export function OrgShell({ slug, signOut, children }: { slug: string; signOut: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const me = trpc.me.get.useQuery();
  const org = me.data?.orgs.find((o) => o.slug === slug) ?? null;
  // Set synchronously during render, so the children's first queries already carry x-org-id.
  const [boundOrg, setBoundOrg] = useState<string | null>(null);
  // Insights shows for admins and team leads (dashboard) and for whoever may see the leaderboard.
  const insights = trpc.insights.settings.useQuery(undefined, { enabled: !!org && boundOrg === org.orgId, staleTime: 60_000 });
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
      <div className="min-h-dvh">
        {/* Padded away from the notch and rounded corners (viewport-fit=cover in the root layout). */}
        <header className="border-b pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 md:gap-x-6">
            <Link href="/orgs" className="font-semibold">
              AutoDev
            </Link>
            {/* Phones: one line between the logo and the bell; the full name is in the tooltip. */}
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm md:flex-none" title={org.name}>
              <span className="truncate">{org.name}</span>
              <Badge variant="outline" className="hidden shrink-0 sm:inline-flex">
                {org.role}
              </Badge>
            </span>
            {/* Phones: its own row that scrolls sideways, instead of wrapping into a block of links. */}
            <nav aria-label="Main" className="no-scrollbar -mx-4 order-last flex w-[calc(100%+2rem)] gap-1 overflow-x-auto whitespace-nowrap px-4 text-sm md:order-none md:mx-0 md:w-auto md:overflow-visible md:px-0">
              {navFor(insights.data).map((n) => {
                const href = `/o/${slug}/${n.href}`;
                return (
                  <Link
                    key={n.href}
                    href={href}
                    aria-current={pathname.startsWith(href) ? 'page' : undefined}
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
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <NotificationsBell slug={slug} />
              {signOut}
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-8">
          {!pathname.startsWith(`/o/${slug}/onboarding`) && <OrgBanner slug={slug} isAdmin={org.role === 'owner' || org.role === 'admin'} />}
          {children}
        </main>
      </div>
    </OrgContext.Provider>
  );
}
