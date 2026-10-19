'use client';

import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@autodev/ui';
import { ConfigCommands } from '@/components/commands';
import { relativeTime } from '@/lib/format';
import { trpc } from '@/lib/trpc';
import { useEvents } from '@/lib/use-events';
import { useOrg } from '../org-shell';
import { toast } from 'sonner';

export default function BuildersPage() {
  const org = useOrg();
  const isAdmin = org.role === 'owner' || org.role === 'admin';
  const utils = trpc.useUtils();
  // Your builders' presence, pairing and revocation arrive on your topic. Other members' team
  // builders aren't on it, so the slower poll still covers them.
  const list = trpc.builders.list.useQuery(undefined, { refetchInterval: 30_000 });
  const pending = trpc.builders.pendingConfirmations.useQuery(undefined, { refetchInterval: 30_000 });
  const refresh = () => Promise.all([utils.builders.list.invalidate(), utils.builders.pendingConfirmations.invalidate()]);
  const me = trpc.me.get.useQuery();
  useEvents(org.orgId, me.data?.user ? [`user:${me.data.user.id}`] : [], (events) => {
    if (events.some((e) => e.type.startsWith('builder.'))) void refresh();
  });
  const revoke = trpc.builders.revoke.useMutation({
    onSuccess: () => {
      toast.success('Builder revoked');
      return refresh();
    },
  });
  const share = trpc.builders.setShared.useMutation({ onSuccess: refresh });
  const confirm = trpc.builders.confirmRepo.useMutation({ onSuccess: refresh });
  const apiUrl = typeof window === 'undefined' ? '' : (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Builders</h1>
        <p className="text-sm text-muted-foreground">
          Builders run your tasks’ tests on your own machine. They connect out to AutoDev (no open ports) and only run the commands in the base branch’s
          .autodev.yml, in Docker, in a temporary copy of the repo.
        </p>
      </div>

      {pending.data?.map((p) => (
        <Card key={`${p.builderId}-${p.repoId}`} className="border-2 border-status-warning">
          <CardHeader>
            <CardTitle className="text-base">
              <span aria-hidden>⚠️ </span>First run of {p.repoFullName} on “{p.builderName}”
            </CardTitle>
            <CardDescription>A test job is waiting. Before anything runs on this machine for this repository, check the commands:</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ConfigCommands config={p.config} />
            <Button onClick={() => confirm.mutate({ builderId: p.builderId, repoId: p.repoId })} disabled={confirm.isPending}>
              Allow these commands for {p.repoFullName}
            </Button>
          </CardContent>
        </Card>
      ))}

      {list.data?.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Add your first builder</CardTitle>
            <CardDescription>On the machine where you develop (Docker recommended):</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{`npx @autodev/runner-cli login --api ${apiUrl}\nnpx @autodev/runner-cli start`}</pre>
          </CardContent>
        </Card>
      )}

      <ul className="grid gap-4 md:grid-cols-2">
        {list.data?.map((b) => (
          <li key={b.id}>
            <Card>
              <CardHeader className="space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{b.name}</CardTitle>
                  <Badge variant={b.online ? 'secondary' : 'outline'}>
                    <span aria-hidden className={b.online ? 'text-[#0ca30c]' : 'text-muted-foreground'}>
                      ●{' '}
                    </span>
                    {b.online ? (b.runningJob ? 'Running a job' : 'Online') : 'Offline'}
                  </Badge>
                </div>
                <CardDescription>
                  {b.kind === 'team' ? `Team builder (by ${b.ownerLogin})` : 'Personal'} · {b.os ?? 'unknown OS'} {b.arch ?? ''} · CLI {b.cliVersion ?? '—'} · last seen {relativeTime(b.lastSeenAt)}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {!b.dockerAvailable && b.os && <Alert>Docker isn’t available on this builder, so it can only run jobs if started with --no-docker.</Alert>}
                <div>
                  <div className="text-xs text-muted-foreground">Repositories</div>
                  {b.bindings.length ? (
                    <ul className="mt-1 space-y-0.5">
                      {b.bindings.map((x) => (
                        <li key={x.repoId}>
                          {x.fullName} {x.confirmed ? <span className="text-xs text-muted-foreground">✓ allowed</span> : <span className="text-xs">needs first-run approval</span>}
                          {x.localPath && <span className="block break-all font-mono text-xs text-muted-foreground">{x.localPath}</span>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-muted-foreground">None yet. Run <code className="font-mono">autodev bind</code> in a clone to reuse it.</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {b.kind === 'team' && isAdmin && (
                    <Button size="sm" variant="outline" onClick={() => share.mutate({ builderId: b.id, allowShared: !b.allowShared })}>
                      {b.allowShared ? 'Stop sharing with the team' : 'Share with the team'}
                    </Button>
                  )}
                  {(b.mine || isAdmin) && (
                    <Button size="sm" variant="ghost" onClick={() => window.confirm(`Revoke “${b.name}”? It disconnects immediately.`) && revoke.mutate({ builderId: b.id })}>
                      Revoke
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
