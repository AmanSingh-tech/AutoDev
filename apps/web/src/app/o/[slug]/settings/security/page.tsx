'use client';

import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input } from '@autodev/ui';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { relativeTime } from '@/lib/format';
import { getCurrentOrgId, trpc } from '@/lib/trpc';

type Retention = { chatRetentionDays: number | null; agentTraceRetentionDays: number | null; notificationRetentionDays: number | null };

const RETENTION: { key: keyof Retention; label: string; hint: string }[] = [
  { key: 'chatRetentionDays', label: 'Repo chat and team rooms', hint: 'Questions, answers and room messages.' },
  { key: 'agentTraceRetentionDays', label: 'Agent traces', hint: 'Step-by-step agent output and full transcripts of finished runs. Plans, designs, diffs and PRs are kept.' },
  { key: 'notificationRetentionDays', label: 'Notifications', hint: 'In-app notifications, read or not.' },
];

const days = (v: string) => (v.trim() === '' ? null : Number(v));

/** Retention, IP allowlist, data region and audit export. Admins only. */
export default function SecuritySettingsPage() {
  const utils = trpc.useUtils();
  const q = trpc.governance.get.useQuery(undefined, { retry: false });
  const onError = (e: { message: string }) => toast.error(e.message);
  const refresh = () => utils.governance.get.invalidate();

  const [retention, setRetention] = useState<Record<keyof Retention, string> | null>(null);
  const [allowlist, setAllowlist] = useState<string | null>(null);
  const [siem, setSiem] = useState<{ url: string; secret: string; enabled: boolean } | null>(null);
  const [range, setRange] = useState({ from: '', to: '', format: 'csv' });
  useEffect(() => {
    if (!q.data) return;
    setRetention((r) => r ?? (Object.fromEntries(RETENTION.map(({ key }) => [key, q.data[key]?.toString() ?? ''])) as Record<keyof Retention, string>));
    setAllowlist((a) => a ?? q.data.ipAllowlist.join('\n'));
    setSiem((s) => s ?? { url: q.data.siem?.url ?? '', secret: '', enabled: q.data.siem?.enabled ?? true });
  }, [q.data]);

  const saveRetention = trpc.governance.setRetention.useMutation({ onSuccess: () => (toast.success('Retention saved'), refresh()), onError });
  const saveAllowlist = trpc.governance.setIpAllowlist.useMutation({
    onSuccess: (r) => {
      setAllowlist(r.entries.join('\n'));
      toast.success(r.entries.length ? `IP allowlist on: ${r.entries.length} ${r.entries.length === 1 ? 'entry' : 'entries'}` : 'IP allowlist off');
      void refresh();
    },
    onError,
  });
  const saveSiem = trpc.governance.setSiem.useMutation({ onSuccess: () => (toast.success('SIEM endpoint saved'), setSiem((s) => s && { ...s, secret: '' }), refresh()), onError });
  const removeSiem = trpc.governance.removeSiem.useMutation({ onSuccess: () => (toast.success('SIEM endpoint removed'), setSiem({ url: '', secret: '', enabled: true }), refresh()), onError });
  const testSiem = trpc.governance.testSiem.useMutation({
    onSuccess: (r) => (r.ok ? toast.success(`The endpoint answered ${r.status}`) : toast.error(r.status ? `The endpoint answered ${r.status}: ${r.body}` : `Couldn’t reach it: ${r.body}`)),
    onError,
  });

  if (q.error) return <Alert>Only owners and admins can see security settings.</Alert>;
  if (!q.data || !retention || allowlist === null || !siem) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const g = q.data;
  const exportUrl = () => {
    const p = new URLSearchParams({ org: getCurrentOrgId() ?? '', format: range.format });
    if (range.from) p.set('from', range.from);
    if (range.to) p.set('to', range.to);
    return `/api/audit/export?${p}`;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Security</h1>
        <p className="text-sm text-muted-foreground">Data retention, network access and the audit log. Every change here is itself audited.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Data retention</CardTitle>
          <CardDescription>
            Deleted nightly once older than this many days (7–3650). Empty keeps forever. Builder logs follow the {g.logRetentionDays}-day setting under General. The audit
            log is never deleted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              saveRetention.mutate({
                chatRetentionDays: days(retention.chatRetentionDays),
                agentTraceRetentionDays: days(retention.agentTraceRetentionDays),
                notificationRetentionDays: days(retention.notificationRetentionDays),
              });
            }}
          >
            {RETENTION.map((r) => (
              <div key={r.key} className="grid gap-1 sm:grid-cols-[1fr_8rem] sm:items-center sm:gap-4">
                <label htmlFor={r.key} className="text-sm">
                  <span className="font-medium">{r.label}</span>
                  <span className="block text-muted-foreground">{r.hint}</span>
                </label>
                <Input
                  id={r.key}
                  inputMode="numeric"
                  placeholder="Keep"
                  value={retention[r.key]}
                  onChange={(e) => setRetention({ ...retention, [r.key]: e.target.value.replace(/\D/g, '') })}
                  aria-describedby={`${r.key}-unit`}
                />
                <span id={`${r.key}-unit`} className="sr-only">
                  days
                </span>
              </div>
            ))}
            <Button type="submit" disabled={saveRetention.isPending}>
              Save retention
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>IP allowlist</CardTitle>
          <CardDescription>
            When set, the app and API only answer for this organization from these networks. One address or CIDR range per line. Your address now:{' '}
            <code className="rounded bg-muted px-1">{g.yourIp ?? 'unknown'}</code>. It has to be on the list, so you can’t lock yourself out.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              saveAllowlist.mutate({ entries: allowlist.split(/[\s,]+/).filter(Boolean) });
            }}
          >
            <label htmlFor="allowlist" className="sr-only">
              Allowed networks
            </label>
            <textarea
              id="allowlist"
              rows={5}
              className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
              placeholder={'203.0.113.0/24\n2001:db8::/32'}
              value={allowlist}
              onChange={(e) => setAllowlist(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={saveAllowlist.isPending}>
                Save allowlist
              </Button>
              {g.ipAllowlist.length > 0 && (
                <Button type="button" variant="outline" disabled={saveAllowlist.isPending} onClick={() => saveAllowlist.mutate({ entries: [] })}>
                  Turn off
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Data region</CardTitle>
          <CardDescription>
            This organization’s data lives in <span className="font-medium text-foreground">{g.dataRegion}</span>
            {g.deploymentRegion !== g.dataRegion && <> (this server is {g.deploymentRegion})</>}. The region is set when the organization is created; moving it is done with
            us.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Audit log</CardTitle>
          <CardDescription>Download it, or stream every new entry to your SIEM.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              From
              <Input type="date" className="mt-1 w-40" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            </label>
            <label className="text-sm">
              To (not included)
              <Input type="date" className="mt-1 w-40" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
            </label>
            <label className="text-sm">
              Format
              <select className="mt-1 block h-9 rounded-md border bg-background px-2 text-sm" value={range.format} onChange={(e) => setRange({ ...range, format: e.target.value })}>
                <option value="csv">CSV</option>
                <option value="ndjson">NDJSON</option>
              </select>
            </label>
            <Button asChild variant="outline">
              <a href={exportUrl()} download>
                Download
              </a>
            </Button>
          </div>

          <form
            className="space-y-3 border-t pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              saveSiem.mutate({ url: siem.url, ...(siem.secret ? { secret: siem.secret } : {}), enabled: siem.enabled });
            }}
          >
            <div>
              <h3 className="font-medium">SIEM endpoint</h3>
              <p className="text-sm text-muted-foreground">
                New entries are POSTed every 5 minutes as NDJSON, signed with your secret: header <code>X-AutoDev-Signature: t=…,v1=…</code>, HMAC-SHA256 of{' '}
                <code>{'{t}.{body}'}</code>. Failed batches are retried from the same place.
              </p>
            </div>
            <label className="block text-sm">
              HTTPS URL
              <Input className="mt-1" type="url" placeholder="https://siem.example.com/autodev" value={siem.url} onChange={(e) => setSiem({ ...siem, url: e.target.value })} required />
            </label>
            <label className="block text-sm">
              Signing secret {g.siem && <span className="text-muted-foreground">(leave empty to keep the one ending in {g.siem.secretLast4})</span>}
              <Input className="mt-1" type="password" autoComplete="off" minLength={16} value={siem.secret} onChange={(e) => setSiem({ ...siem, secret: e.target.value })} required={!g.siem} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={siem.enabled} onChange={(e) => setSiem({ ...siem, enabled: e.target.checked })} />
              Sending
            </label>
            {g.siem && (
              <p className="text-sm text-muted-foreground">
                {g.siem.lastSentAt ? `Last delivery ${relativeTime(g.siem.lastSentAt)}.` : 'Nothing sent yet.'}
                {g.siem.lastError && <span className="text-destructive"> Last error: {g.siem.lastError}</span>}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={saveSiem.isPending}>
                Save endpoint
              </Button>
              {g.siem && (
                <>
                  <Button type="button" variant="outline" disabled={testSiem.isPending} onClick={() => testSiem.mutate()}>
                    {testSiem.isPending ? 'Sending…' : 'Send a test'}
                  </Button>
                  <Button type="button" variant="ghost" disabled={removeSiem.isPending} onClick={() => confirm('Stop streaming the audit log and remove this endpoint?') && removeSiem.mutate()}>
                    Remove
                  </Button>
                </>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
