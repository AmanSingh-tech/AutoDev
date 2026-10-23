'use client';

import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@autodev/ui';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { goToStripe } from '@/components/billing-bits';
import { trpc } from '@/lib/trpc';
import { useOrg } from '../../org-shell';

const STATUS: Record<string, string> = {
  trial: 'Free trial',
  trial_ended: 'Trial ended',
  active: 'Active',
  trialing: 'Trial (Stripe)',
  past_due: 'Payment failed',
  canceled: 'Cancelled',
  incomplete: 'Waiting for payment',
  incomplete_expired: 'Checkout expired',
  unpaid: 'Unpaid',
};
const PLAN: Record<string, string> = { team: 'Team', business: 'Business', enterprise: 'Enterprise' };
const PLAN_HINT: Record<string, string> = {
  team: 'Per seat. Every feature for one team: tasks, chat, builders, insights and the Group Agent.',
  business: 'Per seat. Larger orgs: more Group Agent capacity and priority support.',
};
/** Where the Enterprise card links (a contact form or mailto:), set per deployment. */
const SALES_URL = process.env.NEXT_PUBLIC_SALES_URL;
const date = (d: Date | string | null) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

/** Plan, seats and the way to Stripe. Members see the status; owners and admins can change it. */
export default function BillingPage() {
  const params = useSearchParams();
  const org = useOrg();
  const isAdmin = org.role === 'owner' || org.role === 'admin';
  const utils = trpc.useUtils();
  const status = trpc.billing.status.useQuery();
  const sync = trpc.billing.syncSeats.useMutation({
    onSuccess: (r) => {
      toast.success(r ? `Seats updated from ${r.from} to ${r.to}` : 'Seats already match the members');
      void utils.billing.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const c = params.get('checkout');
    if (c === 'success') toast.success('Thanks! The plan shows here as soon as Stripe confirms it.');
    if (c === 'cancelled') toast('Checkout cancelled. Nothing was charged.');
    // Stripe's webhook usually lands within seconds of the redirect.
    if (c === 'success') {
      const t = setTimeout(() => void utils.billing.invalidate(), 4000);
      return () => clearTimeout(t);
    }
  }, [params, utils]);

  const go = async (path: 'checkout' | 'portal', body?: Record<string, unknown>) => {
    setBusy(path + (body?.plan ?? ''));
    try {
      await goToStripe(path, body);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(null);
    }
  };

  if (!status.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const b = status.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Billing</h1>
        <p className="text-sm text-muted-foreground">Plans are per seat: every active member of the organization is one seat. AI usage is billed by your own provider keys.</p>
      </div>

      {!b.enabled ? (
        <Alert>Billing isn’t set up on this server, so every feature is available without a plan.</Alert>
      ) : (
        <>
          {!b.canRun && <Alert tone="destructive">{b.blockedReason}</Alert>}
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {b.plan ? PLAN[b.plan] : 'No plan yet'}
                <Badge variant={b.canRun ? 'outline' : 'destructive'}>{STATUS[b.status] ?? b.status}</Badge>
              </CardTitle>
              <CardDescription>
                {b.status === 'trial' && b.trialEndsAt && <>The trial ends on {date(b.trialEndsAt)}. </>}
                {b.status === 'past_due' && b.graceUntil && <>AI work keeps running until {date(b.graceUntil)} while the payment is retried. </>}
                {b.plan && b.currentPeriodEnd && <>{b.cancelAtPeriodEnd ? 'Ends' : 'Renews'} on {date(b.currentPeriodEnd)}. </>}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid grid-cols-2 gap-4 text-sm sm:max-w-sm">
                <div>
                  <dt className="text-muted-foreground">Active members</dt>
                  <dd className="text-lg font-medium tabular-nums">{b.members}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Seats billed</dt>
                  <dd className="text-lg font-medium tabular-nums">{b.plan ? b.seats : '—'}</dd>
                </div>
              </dl>
              {isAdmin && b.plan && (
                <div className="flex flex-wrap gap-2">
                  {b.hasCustomer && (
                    <Button onClick={() => void go('portal')} disabled={!!busy}>
                      {busy === 'portal' ? 'Opening Stripe…' : 'Manage billing'}
                    </Button>
                  )}
                  {b.seats !== b.members && (
                    <Button variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}>
                      Update seats now
                    </Button>
                  )}
                </div>
              )}
              {b.plan && <p className="text-xs text-muted-foreground">Seats follow active members every night; changes are prorated by Stripe.</p>}
            </CardContent>
          </Card>

          {(!b.plan || b.status === 'canceled' || b.status === 'incomplete_expired') && (
            <section aria-labelledby="plans" className="space-y-3">
              <h2 id="plans" className="font-medium">
                Choose a plan
              </h2>
              {!isAdmin && <p className="text-sm text-muted-foreground">Only owners and admins can choose a plan.</p>}
              <div className="grid gap-4 md:grid-cols-3">
                {b.plans.map((p) => (
                  <Card key={p.id}>
                    <CardHeader>
                      <CardTitle>{p.label}</CardTitle>
                      <CardDescription>{PLAN_HINT[p.id]}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Button className="w-full" disabled={!isAdmin || !!busy} onClick={() => void go('checkout', { plan: p.id })}>
                        {busy === `checkout${p.id}` ? 'Opening Stripe…' : `Choose ${p.label}`}
                      </Button>
                    </CardContent>
                  </Card>
                ))}
                <Card>
                  <CardHeader>
                    <CardTitle>Enterprise</CardTitle>
                    <CardDescription>SSO and SCIM, audit export, data region and self-hosting. Invoiced yearly.</CardDescription>
                  </CardHeader>
                  {SALES_URL && (
                    <CardContent>
                      <Button className="w-full" variant="outline" asChild>
                        <a href={SALES_URL}>Talk to us</a>
                      </Button>
                    </CardContent>
                  )}
                </Card>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
