'use client';

import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@autodev/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { InstallAppButton } from '@/components/install-app';
import { trpc } from '@/lib/trpc';

export function OrgPicker() {
  const router = useRouter();
  const me = trpc.me.get.useQuery();
  const orgs = me.data?.orgs ?? [];

  useEffect(() => {
    if (orgs.length === 1) router.replace(`/o/${orgs[0]!.slug}/repos`);
  }, [orgs, router]);

  if (me.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (me.error) return <p className="text-sm text-destructive">Couldn’t load your organizations.</p>;

  if (orgs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Get started</CardTitle>
          <CardDescription>
            If your company already uses AutoDev, ask an admin to install the AutoDev GitHub App on
            your GitHub organization, then sign in again. GitHub org admins can install it now.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <InstallAppButton />
        </CardContent>
      </Card>
    );
  }

  return (
    <ul className="space-y-2">
      {orgs.map((o) => (
        <li key={o.orgId}>
          <Link
            href={`/o/${o.slug}/repos`}
            className="flex items-center justify-between rounded-lg border px-4 py-3 hover:bg-muted/50"
          >
            <span className="font-medium">{o.name}</span>
            <Badge variant="outline">{o.role}</Badge>
          </Link>
        </li>
      ))}
    </ul>
  );
}
