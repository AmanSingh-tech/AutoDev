'use client';

import { Button } from '@autodev/ui';
import { Menu, Search, ShieldAlert, Sparkles, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { OrgBanner } from '@/components/billing-bits';
import { NotificationsBell } from '@/components/notifications-bell';
import { CommandPalette } from '@/components/shell/command-palette';
import { AutoDevMark, SidebarContent } from '@/components/shell/sidebar';
import { setCurrentOrgId, trpc, type RouterOutputs } from '@/lib/trpc';

type Membership = RouterOutputs['me']['get']['orgs'][number];
const OrgContext = createContext<Membership | null>(null);

export function useOrg(): Membership {
  const org = useContext(OrgContext);
  if (!org) throw new Error('useOrg must be used inside OrgShell');
  return org;
}

/** A centered, full-page message for when the org can't be shown (not found, SSO, IP, region). */
function Blocked({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-card">
        <span className="mx-auto mb-4 flex size-10 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <ShieldAlert aria-hidden className="size-5" />
        </span>
        <h1 className="text-lg font-semibold">{title}</h1>
        <div className="mt-2 space-y-4 text-sm text-muted-foreground">{children}</div>
      </div>
    </main>
  );
}

const backToOrgs = (
  <p>
    <Link href="/orgs" className="font-medium text-foreground underline underline-offset-4">
      Back to your organizations
    </Link>
  </p>
);

export function OrgShell({ slug, signOut, children }: { slug: string; signOut: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const me = trpc.me.get.useQuery();
  const org = me.data?.orgs.find((o) => o.slug === slug) ?? null;
  // Set synchronously during render, so the children's first queries already carry x-org-id.
  const [boundOrg, setBoundOrg] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  // Close the phone drawer when the page changes.
  useEffect(() => setDrawer(false), [pathname]);
  // Insights shows for admins and team leads (dashboard) and for whoever may see the leaderboard.
  const insights = trpc.insights.settings.useQuery(undefined, { enabled: !!org && boundOrg === org.orgId, staleTime: 60_000, retry: false });
  // B-7: an IP allowlist or another data region refuses every org call; say so once, instead of broken pages.
  const denied = insights.error?.data?.orgAccess;
  // The SSO callback comes back with ?sso_error=… when sign-in didn't work.
  useEffect(() => {
    const err = new URLSearchParams(window.location.search).get('sso_error');
    if (err) toast.error(err);
  }, []);
  if (org && boundOrg !== org.orgId) {
    // Query keys don't include the org, so drop org-scoped cache from the previous org.
    if (boundOrg) queryClient.removeQueries({ predicate: (q) => JSON.stringify(q.queryKey[0]) !== '["me","get"]' });
    setCurrentOrgId(org.orgId);
    setBoundOrg(org.orgId);
  }

  if (me.isLoading)
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <AutoDevMark className="size-8 animate-pulse" />
        <span className="sr-only">Loading…</span>
      </div>
    );
  if (!org) {
    return (
      <Blocked title="Organization not found">
        <p>You aren’t a member of “{slug}”, or it doesn’t exist.</p>
        {backToOrgs}
      </Blocked>
    );
  }

  if (denied === 'sso_required') {
    return (
      <Blocked title="Sign in with single sign-on">
        <p>{insights.error?.message}</p>
        <Button asChild>
          <a href={`/api/sso/start?org=${org.orgId}&returnTo=${encodeURIComponent(pathname)}`}>Continue with SSO</a>
        </Button>
        {backToOrgs}
      </Blocked>
    );
  }

  if (denied === 'ip_blocked' || denied === 'wrong_region') {
    return (
      <Blocked title={denied === 'ip_blocked' ? 'Not available from this network' : 'Wrong region'}>
        <p>{insights.error?.message}</p>
        {backToOrgs}
      </Blocked>
    );
  }

  const sidebar = (onNavigate?: () => void) => <SidebarContent slug={slug} org={org} access={insights.data} signOut={signOut} onNavigate={onNavigate} />;

  return (
    <OrgContext.Provider value={org}>
      <div className="flex min-h-dvh">
        {/* Desktop: a fixed sidebar. Phones and tablets: the same content in a drawer. */}
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 border-r bg-sidebar lg:block">{sidebar()}</aside>
        {drawer && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
            <div className="absolute inset-0 bg-foreground/25 backdrop-blur-[2px] animate-fade" onClick={() => setDrawer(false)} />
            <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r bg-sidebar pt-[env(safe-area-inset-top)] shadow-pop animate-enter">
              <button onClick={() => setDrawer(false)} className="absolute right-2 top-[calc(0.75rem+env(safe-area-inset-top))] rounded-md p-1.5 text-muted-foreground hover:bg-secondary" aria-label="Close menu">
                <X aria-hidden className="size-4" />
              </button>
              {sidebar(() => setDrawer(false))}
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 border-b bg-background/80 pt-[env(safe-area-inset-top)] backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
            <div className="flex h-14 items-center gap-2 px-4 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:px-6">
              <Button variant="ghost" size="icon" className="-ml-2 lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu">
                <Menu aria-hidden />
              </Button>
              <Link href={`/o/${slug}`} className="flex items-center gap-2 font-semibold lg:hidden">
                <AutoDevMark />
                <span className="truncate">{org.name}</span>
              </Link>
              <button
                onClick={() => setPalette(true)}
                className="ml-auto hidden h-9 w-64 items-center gap-2 rounded-md border bg-card px-3 text-sm text-muted-foreground shadow-xs transition-colors hover:border-foreground/20 sm:flex lg:ml-0"
              >
                <Search aria-hidden className="size-4" />
                <span className="flex-1 text-left">Go to…</span>
                <kbd className="rounded border bg-secondary px-1.5 py-0.5 font-sans text-[10px]">⌘K</kbd>
              </button>
              <div className="ml-auto flex items-center gap-1 sm:ml-auto">
                <Button variant="ghost" size="icon" className="sm:hidden" onClick={() => setPalette(true)} aria-label="Go to a page">
                  <Search aria-hidden />
                </Button>
                <NotificationsBell slug={slug} />
              </div>
            </div>
          </header>
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-[calc(2.5rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 lg:px-8 lg:pt-8">
            {org.demo && (
              <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-primary/20 bg-accent/60 px-3.5 py-2.5 text-sm text-accent-foreground">
                <Sparkles aria-hidden className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">Demo organization.</span> The agent is simulated: start a task, approve its plan and watch it work. Nothing reaches GitHub or an AI provider.
                </span>
                <Link href="/orgs?pick=1" className="shrink-0 font-medium underline-offset-4 hover:underline">
                  Use your own repos
                </Link>
              </div>
            )}
            {!pathname.startsWith(`/o/${slug}/onboarding`) && <OrgBanner slug={slug} isAdmin={org.role === 'owner' || org.role === 'admin'} billingManager={org.billingManager} hideSetup={pathname === `/o/${slug}`} />}
            {children}
          </main>
        </div>
      </div>
      <CommandPalette slug={slug} access={insights.data} open={palette} onOpenChange={setPalette} />
    </OrgContext.Provider>
  );
}
