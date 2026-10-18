'use client';

import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, NativeSelect } from '@autodev/ui';
import { useEffect, useState } from 'react';
import { trpc, type RouterOutputs } from '@/lib/trpc';

type Org = RouterOutputs['orgs']['current'];
type Form = Pick<Org, 'defaultTaskMode' | 'staleBranchDays' | 'staleBranchAction' | 'maxFixCycles' | 'taskKeyPrefix' | 'allowUserKeys'> & {
  // A DB check constraint guarantees the default role is never owner.
  defaultMemberRole: 'admin' | 'developer' | 'viewer';
};

const MODES = [
  { value: 'plan_lld', label: 'Plan → LLD → code (two approvals)' },
  { value: 'plan_only', label: 'Plan → code (one approval)' },
  { value: 'direct', label: 'Direct (no approvals)' },
] as const;

export default function SettingsPage() {
  const utils = trpc.useUtils();
  const org = trpc.orgs.current.useQuery();
  const installs = trpc.installations.list.useQuery();
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState(false);
  const save = trpc.orgs.updateSettings.useMutation({
    onSuccess: (data) => {
      utils.orgs.current.setData(undefined, (prev) => (prev ? { ...prev, ...data } : prev));
      setSaved(true);
    },
  });

  useEffect(() => {
    if (org.data && !form) setForm(org.data as Form);
  }, [org.data, form]);

  if (!org.data || !form) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const readOnly = org.data.myRole !== 'owner' && org.data.myRole !== 'admin';
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setSaved(false);
    setForm({ ...form, [k]: v });
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">General</h1>
      {readOnly && <Alert>Only admins can change these settings.</Alert>}
      <Card>
        <CardHeader>
          <CardTitle>Organization defaults</CardTitle>
          <CardDescription>Applies to new tasks. Admins can lock a mode per repository (next phases).</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid max-w-xl gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              const changed = Object.fromEntries(
                Object.entries(form).filter(([k, v]) => org.data![k as keyof Form] !== v),
              ) as Partial<Form>;
              if (Object.keys(changed).length) save.mutate(changed);
            }}
          >
            <fieldset disabled={readOnly || save.isPending} className="grid gap-4">
              <Field label="Default task mode" id="mode">
                <NativeSelect id="mode" value={form.defaultTaskMode} onChange={(e) => set('defaultTaskMode', e.target.value as Form['defaultTaskMode'])}>
                  {MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Task key prefix" id="prefix" hint="Tasks are numbered like AD-142.">
                <Input id="prefix" value={form.taskKeyPrefix} maxLength={10} onChange={(e) => set('taskKeyPrefix', e.target.value.toUpperCase())} />
              </Field>
              <Field label="Default role for new members" id="role">
                <NativeSelect id="role" value={form.defaultMemberRole} onChange={(e) => set('defaultMemberRole', e.target.value as Form['defaultMemberRole'])}>
                  <option value="developer">developer</option>
                  <option value="viewer">viewer</option>
                  <option value="admin">admin</option>
                </NativeSelect>
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.allowUserKeys} onChange={(e) => set('allowUserKeys', e.target.checked)} />
                Let members add their own personal AI key
              </label>
              <Field label="Max automatic fix cycles after failing tests" id="cycles">
                <Input id="cycles" type="number" min={0} max={10} value={form.maxFixCycles} onChange={(e) => set('maxFixCycles', Number(e.target.value))} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Stale branch after (days)" id="stale">
                  <Input id="stale" type="number" min={1} max={90} value={form.staleBranchDays} onChange={(e) => set('staleBranchDays', Number(e.target.value))} />
                </Field>
                <Field label="Then" id="stale-action">
                  <NativeSelect id="stale-action" value={form.staleBranchAction} onChange={(e) => set('staleBranchAction', e.target.value as Form['staleBranchAction'])}>
                    <option value="notify_owner">Notify the task owner</option>
                    <option value="auto_open_pr">Open the PR automatically</option>
                  </NativeSelect>
                </Field>
              </div>
            </fieldset>
            {save.error && <Alert tone="destructive">{save.error.message}</Alert>}
            {saved && <p className="text-sm text-muted-foreground">Saved.</p>}
            {!readOnly && (
              <div>
                <Button type="submit" disabled={save.isPending}>
                  {save.isPending ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>GitHub installation</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {installs.data?.map((i) => (
            <p key={i.id}>
              Installed on <span className="font-medium">{i.accountLogin}</span>
              {i.suspendedAt && <span className="text-destructive"> (suspended)</span>}
            </p>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, id, hint, children }: { label: string; id: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
