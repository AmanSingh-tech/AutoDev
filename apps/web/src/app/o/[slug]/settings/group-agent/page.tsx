'use client';

import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, NativeSelect, Table, TBody, TD, TH, THead, TR } from '@autodev/ui';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { useOrg } from '../../org-shell';

const SAFETY = [
  { level: 1, label: '1 · Suggest only' },
  { level: 2, label: '2 · Draft PR' },
  { level: 3, label: '3 · PR for low-risk fixes' },
];

/** Group Agent settings: on/off, its own budget and PR cap, and per-repo scanning, safety level and maintainer. */
export default function GroupAgentSettingsPage() {
  const org = useOrg();
  const isAdmin = org.role === 'owner' || org.role === 'admin';
  const utils = trpc.useUtils();
  const q = trpc.groupAgent.policies.get.useQuery(undefined, { enabled: isAdmin });
  const [form, setForm] = useState<{ enabled: boolean; budget: string; cap: string } | null>(null);
  useEffect(() => {
    if (q.data && !form) setForm({ enabled: q.data.enabled, budget: q.data.monthlyBudgetUsd === null ? '' : String(q.data.monthlyBudgetUsd), cap: String(q.data.weeklyPrCap) });
  }, [q.data, form]);
  const save = trpc.groupAgent.policies.update.useMutation({
    onSuccess: () => {
      toast.success('Group Agent settings saved');
      void utils.groupAgent.invalidate();
    },
  });
  const saveRepo = trpc.groupAgent.policies.updateRepo.useMutation({
    onSuccess: () => {
      toast.success('Repository settings saved');
      void utils.groupAgent.policies.get.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  if (!isAdmin) return <p className="text-sm text-muted-foreground">Only admins can change Group Agent settings.</p>;
  if (!q.data || !form) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Group Agent</h1>
        <p className="text-sm text-muted-foreground">
          Scans every repository nightly at 03:30 UTC and sends admins a digest on Mondays. Dependency checks send package names and versions to
          OSV.dev and the package registries, never code.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Organization</CardTitle>
          <CardDescription>The budget and PR cap apply to the pull requests the agent opens itself, which come next.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid max-w-xl gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate({ enabled: form.enabled, monthlyBudgetUsd: form.budget.trim() ? Number(form.budget) : null, weeklyPrCap: Number(form.cap) });
            }}
          >
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
              Run the Group Agent (nightly scans and the weekly digest)
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="ga-budget">Monthly AI budget (USD)</Label>
                <Input id="ga-budget" type="number" min={0} step="0.01" placeholder="No limit" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ga-cap">Pull requests per week</Label>
                <Input id="ga-cap" type="number" min={0} max={100} value={form.cap} onChange={(e) => setForm({ ...form, cap: e.target.value })} />
              </div>
            </div>
            {save.error && <Alert tone="destructive">{save.error.message}</Alert>}
            <div>
              <Button type="submit" disabled={save.isPending}>
                Save
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Repositories</CardTitle>
          <CardDescription>
            The safety level decides what the agent may do with a fix: suggest it, open a draft PR (the default), or open a normal PR for patch bumps and
            lint fixes after tests pass. Merging is always up to people. The maintainer's builder runs its tests.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH className="min-w-[12rem]">Repository</TH>
                <TH>Scan</TH>
                <TH>Safety level</TH>
                <TH>Maintainer</TH>
              </TR>
            </THead>
            <TBody>
              {q.data.repos.map((r) => (
                <TR key={r.repoId}>
                  <TD className="max-w-[16rem] truncate" title={r.name}>
                    {r.name}
                  </TD>
                  <TD>
                    <input type="checkbox" aria-label={`Scan ${r.name}`} checked={r.scan} disabled={saveRepo.isPending} onChange={(e) => saveRepo.mutate({ repoId: r.repoId, scan: e.target.checked })} />
                  </TD>
                  <TD>
                    <NativeSelect aria-label={`Safety level for ${r.name}`} className="w-auto" value={r.safetyLevel} onChange={(e) => saveRepo.mutate({ repoId: r.repoId, safetyLevel: Number(e.target.value) })}>
                      {SAFETY.map((s) => (
                        <option key={s.level} value={s.level}>
                          {s.label}
                        </option>
                      ))}
                    </NativeSelect>
                  </TD>
                  <TD>
                    <NativeSelect aria-label={`Maintainer of ${r.name}`} className="w-auto" value={r.maintainerUserId ?? ''} onChange={(e) => saveRepo.mutate({ repoId: r.repoId, maintainerUserId: e.target.value || null })}>
                      <option value="">Nobody yet</option>
                      {r.candidates.map((c) => (
                        <option key={c.userId} value={c.userId}>
                          {c.login}
                        </option>
                      ))}
                    </NativeSelect>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
