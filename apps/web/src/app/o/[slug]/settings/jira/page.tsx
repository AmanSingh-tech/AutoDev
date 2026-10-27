'use client';

import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@autodev/ui';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { relativeTime } from '@/lib/format';
import { trpc } from '@/lib/trpc';
import { useOrg } from '../../org-shell';

/** Connect a Jira Cloud site (B-7). Admins only; members see whether it's connected. */
export default function JiraSettingsPage() {
  const org = useOrg();
  const isAdmin = org.role === 'owner' || org.role === 'admin';
  const utils = trpc.useUtils();
  const q = trpc.jira.get.useQuery();
  const [form, setForm] = useState<{ site: string; email: string; token: string; defaultProject: string } | null>(null);
  useEffect(() => {
    if (q.isSuccess && !form) setForm({ site: q.data?.site ?? '', email: q.data?.email ?? '', token: '', defaultProject: q.data?.defaultProject ?? '' });
  }, [q.isSuccess, q.data, form]);
  const connect = trpc.jira.connect.useMutation({
    onSuccess: (r) => {
      toast.success(`Connected to Jira as ${r.account}`);
      setForm((f) => f && { ...f, token: '' });
      void utils.jira.invalidate();
    },
  });
  const disconnect = trpc.jira.disconnect.useMutation({ onSuccess: () => (toast.success('Jira disconnected'), setForm(null), utils.jira.invalidate()) });

  if (!form) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const c = q.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Jira</h1>
        <p className="text-sm text-muted-foreground">
          Link tasks to Jira issues, or create an issue from a task. Status changes and the pull request are posted to the issue as comments every few minutes.
        </p>
      </div>
      {!isAdmin && <Alert>{c ? `Connected to ${c.site}.atlassian.net.` : 'Jira isn’t connected.'} Only admins can change this.</Alert>}

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>{c ? 'Connection' : 'Connect Jira Cloud'}</CardTitle>
            <CardDescription>
              Use a Jira account that can see and comment on the projects you work in (a service account is best). Create an API token at
              id.atlassian.com → Security → API tokens. The token is encrypted and never shown again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid max-w-xl gap-4"
              autoComplete="off"
              onSubmit={(e) => {
                e.preventDefault();
                connect.mutate({ site: form.site, email: form.email, token: form.token || undefined, defaultProject: form.defaultProject || null });
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="site">Site</Label>
                  <div className="flex items-center gap-1 text-sm">
                    <Input id="site" placeholder="acme" value={form.site} onChange={(e) => setForm({ ...form, site: e.target.value.trim() })} required />
                    <span className="shrink-0 text-muted-foreground">.atlassian.net</span>
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="project">Default project key</Label>
                  <Input id="project" placeholder="WEB" value={form.defaultProject} onChange={(e) => setForm({ ...form, defaultProject: e.target.value.toUpperCase().trim() })} />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="email">Account email</Label>
                <Input id="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="token">API token {c && <span className="font-normal text-muted-foreground">(leave empty to keep the one ending in {c.tokenLast4})</span>}</Label>
                <Input id="token" type="password" autoComplete="new-password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} required={!c} />
              </div>
              {connect.error && <Alert tone="destructive">{connect.error.message}</Alert>}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={connect.isPending}>
                  {connect.isPending ? 'Checking…' : c ? 'Save' : 'Check and connect'}
                </Button>
                {c && (
                  <Button type="button" variant="ghost" disabled={disconnect.isPending} onClick={() => confirm('Disconnect Jira? Tasks keep their issue keys.') && disconnect.mutate()}>
                    Disconnect
                  </Button>
                )}
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {isAdmin && c && (
        <Card>
          <CardHeader>
            <CardTitle>Status from Jira</CardTitle>
            <CardDescription>
              To show each issue’s Jira status on its task, add a webhook in Jira (Settings → System → WebHooks) for “Issue updated” and “Issue deleted”, with this
              address. Keep it private: it contains a secret.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <code className="block break-all rounded-md bg-muted px-3 py-2 text-xs">{c.webhookUrl}</code>
            <p className="text-muted-foreground">
              {c.lastSyncedAt ? `Last update sent ${relativeTime(c.lastSyncedAt)}.` : 'Nothing sent yet.'}
              {c.lastError && <span className="text-destructive"> Last error: {c.lastError}</span>}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
