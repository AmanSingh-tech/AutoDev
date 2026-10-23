'use client';

import { Alert } from '@autodev/ui';
import Link from 'next/link';
import { getCurrentOrgId, trpc } from '@/lib/trpc';

/**
 * Hands the browser to Stripe (checkout or the billing portal). These are REST endpoints on the
 * API, reached through the /api/billing proxy with the session cookie.
 */
export async function goToStripe(path: 'checkout' | 'portal', body: Record<string, unknown> = {}) {
  const res = await fetch(`/api/billing/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgId: getCurrentOrgId(), ...body }),
  });
  const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !data.url) throw new Error(data.error ?? `Billing request failed (${res.status})`);
  window.location.assign(data.url);
}

const daysLeft = (d: Date | string) => Math.max(0, Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000));

/**
 * One line above every org page, at most: AI work is blocked by billing (everyone sees it), the
 * trial ends within 3 days (admins), or setup isn't finished (admins, until they dismiss it).
 */
export function OrgBanner({ slug, isAdmin }: { slug: string; isAdmin: boolean }) {
  const billing = trpc.billing.status.useQuery(undefined, { staleTime: 60_000 });
  const onboarding = trpc.onboarding.status.useQuery(undefined, { enabled: isAdmin, staleTime: 60_000 });
  const b = billing.data;
  if (b?.enabled && !b.canRun)
    return (
      <Alert tone="destructive" className="mb-6">
        {b.blockedReason} Existing tasks, chats and pull requests are kept.{' '}
        {isAdmin && (
          <Link href={`/o/${slug}/settings/billing`} className="font-medium underline">
            Open billing
          </Link>
        )}
      </Alert>
    );
  if (isAdmin && b?.enabled && b.status === 'trial' && b.trialEndsAt && daysLeft(b.trialEndsAt) <= 3)
    return (
      <Alert className="mb-6">
        The free trial ends in {daysLeft(b.trialEndsAt)} {daysLeft(b.trialEndsAt) === 1 ? 'day' : 'days'}.{' '}
        <Link href={`/o/${slug}/settings/billing`} className="font-medium underline">
          Choose a plan
        </Link>
      </Alert>
    );
  const o = onboarding.data;
  if (o && !o.complete && !o.dismissed) {
    const done = o.steps.filter((s) => s.done).length;
    return (
      <Alert className="mb-6">
        Setup: {done} of {o.steps.length} steps done.{' '}
        <Link href={`/o/${slug}/onboarding`} className="font-medium underline">
          Finish setting up
        </Link>
      </Alert>
    );
  }
  return null;
}
