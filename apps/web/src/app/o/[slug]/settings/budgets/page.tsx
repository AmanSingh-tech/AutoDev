'use client';

import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, NativeSelect } from '@autodev/ui';
import { useState } from 'react';
import { BudgetMeter } from '@/components/budget-meter';
import { trpc, type RouterOutputs } from '@/lib/trpc';
import { useOrg } from '../../org-shell';

type Budget = RouterOutputs['budgets']['list'][number];

export default function BudgetsPage() {
  const org = useOrg();
  const isAdmin = org.role === 'owner' || org.role === 'admin';
  const budgets = trpc.budgets.list.useQuery();
  const orgBudget = budgets.data?.find((b) => b.scope === 'org');
  const userBudgets = budgets.data?.filter((b) => b.scope === 'user') ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Budgets</h1>
        <p className="text-sm text-muted-foreground">
          Monthly limits in USD (calendar month, UTC). Admins are notified at the warning threshold. At the limit, new agent
          runs are blocked; runs already going finish within their per-task token cap.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Organization</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {orgBudget ? <BudgetMeter label="This month" {...orgBudget} /> : <p className="text-sm text-muted-foreground">No organization budget. Spending is unlimited.</p>}
          {isAdmin && <BudgetForm scope="org" existing={orgBudget} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Per member</CardTitle>
          <CardDescription>A member’s own limit, on top of the organization’s.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {userBudgets.map((b) => (
            <div key={b.id} className="space-y-3">
              <BudgetMeter label={b.userLogin ?? 'member'} {...b} />
              {isAdmin && <BudgetForm scope="user" existing={b} />}
            </div>
          ))}
          {userBudgets.length === 0 && <p className="text-sm text-muted-foreground">No member budgets.</p>}
          {isAdmin && <BudgetForm scope="user" />}
        </CardContent>
      </Card>
    </div>
  );
}

function BudgetForm({ scope, existing }: { scope: 'org' | 'user'; existing?: Budget }) {
  const utils = trpc.useUtils();
  const members = trpc.members.list.useQuery(undefined, { enabled: scope === 'user' && !existing });
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(existing ? String(existing.limitUsd) : '');
  const [soft, setSoft] = useState(existing?.softPct ?? 80);
  const [hard, setHard] = useState(existing?.hardBlock ?? true);
  const [userId, setUserId] = useState('');
  const done = () => {
    setOpen(false);
    void utils.budgets.list.invalidate();
  };
  const save = trpc.budgets.set.useMutation({ onSuccess: done });
  const remove = trpc.budgets.remove.useMutation({ onSuccess: done });

  if (!open) {
    return (
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          {existing ? 'Edit' : scope === 'org' ? 'Set a budget' : 'Add member budget'}
        </Button>
        {existing && (
          <Button variant="ghost" size="sm" onClick={() => confirm('Remove this budget?') && remove.mutate({ id: existing.id })}>
            Remove
          </Button>
        )}
      </div>
    );
  }
  return (
    <form
      className="grid max-w-xl gap-3 rounded-md border p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ scope, userId: scope === 'user' ? (existing?.userId ?? userId) : undefined, limitUsd: Number(limit), softPct: soft, hardBlock: hard });
      }}
    >
      {scope === 'user' && !existing && (
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="member">Member</Label>
          <NativeSelect id="member" value={userId} onChange={(e) => setUserId(e.target.value)} required>
            <option value="">Choose…</option>
            {members.data?.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.githubLogin}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor={`limit-${scope}`}>Monthly limit (USD)</Label>
        <Input id={`limit-${scope}`} type="number" min={1} step="0.01" value={limit} onChange={(e) => setLimit(e.target.value)} required />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`soft-${scope}`}>Warn at (%)</Label>
        <Input id={`soft-${scope}`} type="number" min={1} max={100} value={soft} onChange={(e) => setSoft(Number(e.target.value))} />
      </div>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" checked={hard} onChange={(e) => setHard(e.target.checked)} /> Block new runs at the limit
      </label>
      {save.error && <Alert tone="destructive" className="sm:col-span-2">{save.error.message}</Alert>}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
