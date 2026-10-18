'use client';

import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, NativeSelect } from '@autodev/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { setCurrentOrgId, trpc } from '@/lib/trpc';

/** Approve the code shown by `autodev login`. The builder joins the chosen org. */
export function PairBuilder({ initialCode }: { initialCode: string }) {
  const me = trpc.me.get.useQuery();
  const [orgId, setOrgId] = useState('');
  const [code, setCode] = useState(initialCode);
  const [kind, setKind] = useState<'personal' | 'team'>('personal');
  const approve = trpc.builders.approvePairing.useMutation();
  const orgs = me.data?.orgs ?? [];
  const org = orgs.find((o) => o.orgId === orgId);

  useEffect(() => {
    if (!orgId && orgs.length) setOrgId(orgs[0]!.orgId);
  }, [orgs, orgId]);
  useEffect(() => setCurrentOrgId(orgId || null), [orgId]);

  if (approve.isSuccess) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Builder paired</CardTitle>
          <CardDescription>
            “{approve.data.name}” is connected to {org?.name}. Go back to your terminal and run <code className="font-mono">autodev start</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link className="text-sm underline" href={`/o/${org?.slug}/builders`}>
            See your builders
          </Link>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pair a builder</CardTitle>
        <CardDescription>Only approve a code you started yourself with <code className="font-mono">autodev login</code>. The builder will run tests for your tasks on that machine.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            approve.mutate({ userCode: code, kind });
          }}
        >
          {orgs.length > 1 && (
            <div className="grid gap-1.5">
              <Label htmlFor="org">Organization</Label>
              <NativeSelect id="org" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                {orgs.map((o) => (
                  <option key={o.orgId} value={o.orgId}>
                    {o.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="code">Code from your terminal</Label>
            <Input id="code" className="font-mono uppercase tracking-widest" placeholder="ABCD-EFGH" value={code} onChange={(e) => setCode(e.target.value)} required autoComplete="off" />
          </div>
          {(org?.role === 'owner' || org?.role === 'admin') && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={kind === 'team'} onChange={(e) => setKind(e.target.checked ? 'team' : 'personal')} />
              Team builder (can run other members’ tasks, always in Docker)
            </label>
          )}
          {approve.error && <Alert tone="destructive">{approve.error.message}</Alert>}
          <Button type="submit" disabled={!orgId || approve.isPending}>
            Approve this builder
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
