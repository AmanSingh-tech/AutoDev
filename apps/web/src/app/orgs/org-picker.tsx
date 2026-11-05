'use client';

import { Badge, Button } from '@autodev/ui';
import { ChevronRight, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { InstallAppButton } from '@/components/install-app';
import { OrgMark } from '@/components/shell/sidebar';
import { trpc } from '@/lib/trpc';

export function OrgPicker() {
  const router = useRouter();
  const me = trpc.me.get.useQuery();
  const orgs = me.data?.orgs ?? [];
  // With one org, go straight in, unless the person asked to see the list (the org switcher).
  const pick = useSearchParams().get('pick') === '1';

  useEffect(() => {
    if (orgs.length === 1 && !pick) router.replace(`/o/${orgs[0]!.slug}/repos`);
  }, [orgs, router, pick]);

  if (me.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (me.error) return <p className="text-sm text-destructive">Couldn’t load your organizations.</p>;

  if (orgs.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          You’re not in an organization yet. If your company already uses AutoDev, ask an admin to install the AutoDev GitHub App on your GitHub organization, then
          sign in again. GitHub org admins can install it now.
        </p>
        <div className="flex flex-wrap gap-2">
          <InstallAppButton />
          <Button asChild variant="outline">
            <Link href="/demo">
              <Sparkles aria-hidden />
              Try the demo
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {orgs.map((o) => (
          <li key={o.orgId}>
            <Link href={`/o/${o.slug}/repos`} className="group flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 transition-[border-color,box-shadow] hover:border-primary/40 hover:shadow-card">
              <OrgMark name={o.name} className="size-8" />
              <span className="min-w-0 flex-1 truncate font-medium">{o.name}</span>
              {o.demo && <Badge variant="accent">Demo</Badge>}
              <Badge variant="outline" className="capitalize">
                {o.role}
              </Badge>
              <ChevronRight aria-hidden className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2 border-t pt-4">
        <InstallAppButton label="Add another GitHub organization" variant="outline" />
        {!orgs.some((o) => o.demo) && (
          <Button asChild variant="ghost">
            <Link href="/demo">
              <Sparkles aria-hidden />
              Try the demo
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
