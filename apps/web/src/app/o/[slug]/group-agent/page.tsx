'use client';

import { Alert, Button, cn, Input, NativeSelect } from '@autodev/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { HealthBadge, KIND_LABEL, SeverityBadge } from '@/components/group-agent-bits';
import { Markdown } from '@/components/markdown';
import { relativeTime } from '@/lib/format';
import { trpc, type RouterOutputs } from '@/lib/trpc';
import { useOrg } from '../org-shell';

type Rec = RouterOutputs['groupAgent']['recommendations'][number];
type Status = 'open' | 'dismissed' | 'task_created' | 'pr_opened' | 'resolved' | 'all';

const STATUS_TABS: { id: Status; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'task_created', label: 'Became tasks' },
  { id: 'pr_opened', label: 'PR opened' },
  { id: 'dismissed', label: 'Dismissed' },
  { id: 'resolved', label: 'Resolved' },
];

/** The Group Agent: what the nightly scans found across the org, and what to do about it. Admins only. */
export default function GroupAgentPage() {
  const { slug } = useParams<{ slug: string }>();
  const org = useOrg();
  const utils = trpc.useUtils();
  const isAdmin = org.role === 'owner' || org.role === 'admin';
  const overview = trpc.groupAgent.overview.useQuery(undefined, { enabled: isAdmin });
  const [status, setStatus] = useState<Status>('open');
  const [repoId, setRepoId] = useState('');
  const [kind, setKind] = useState('');
  const recs = trpc.groupAgent.recommendations.useQuery(
    { status, ...(repoId ? { repoId } : {}), ...(kind ? { kind: kind as never } : {}) },
    { enabled: isAdmin },
  );
  const scan = trpc.groupAgent.scanNow.useMutation({
    onSuccess: () => {
      toast.success('Scanning. Results appear here in a few minutes.');
      setTimeout(() => void utils.groupAgent.invalidate(), 30_000);
    },
  });

  if (!isAdmin) return <p className="text-sm text-muted-foreground">The Group Agent is for admins.</p>;
  const o = overview.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Group Agent</h1>
          <p className="text-sm text-muted-foreground">
            Nightly scans of every repository: dependencies, tests, linked repos, spend and stuck work.
            {o?.lastScan ? ` Last scan ${relativeTime(o.lastScan.finishedAt ?? o.lastScan.startedAt)}.` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/group-agent/digest`}>Weekly digest</Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => scan.mutate()} disabled={scan.isPending}>
            Scan now
          </Button>
        </div>
      </div>

      {o && !o.enabled && (
        <Alert>
          The Group Agent is off, so nothing runs at night. Turn it on in{' '}
          <Link href={`/o/${slug}/settings/group-agent`} className="underline">
            Settings → Group Agent
          </Link>
          . Scan now still works.
        </Alert>
      )}
      {o?.lastScan?.errors.length ? (
        <Alert tone="destructive">
          Some checks didn't finish last time, so their findings were left as they were:{' '}
          {o.lastScan.errors.map((e) => `${e.check}${e.repo ? ` (${e.repo})` : ''}: ${e.message}`).join('; ')}
        </Alert>
      ) : null}

      {o && (
        <section aria-labelledby="health" className="space-y-2">
          <h2 id="health" className="text-sm font-medium">
            Repository health
          </h2>
          <p className="text-xs text-muted-foreground">100 minus points per open finding: critical 30, high 15, medium 7, low 2.</p>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {o.repos.map((r) => (
              <li key={r.repoId}>
                <button
                  type="button"
                  onClick={() => setRepoId(repoId === r.repoId ? '' : r.repoId)}
                  aria-pressed={repoId === r.repoId}
                  className={cn('flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted', repoId === r.repoId && 'border-foreground/40 bg-muted')}
                >
                  <span className="min-w-0 truncate" title={r.name}>
                    {r.name}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    {r.open} open
                    <HealthBadge score={r.score} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Open findings: {o.bySeverity.critical} critical, {o.bySeverity.high} high, {o.bySeverity.medium} medium, {o.bySeverity.low} low.
          </p>
        </section>
      )}

      <section aria-labelledby="recs" className="space-y-3">
        <h2 id="recs" className="text-sm font-medium">
          Recommendations
        </h2>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
          <div className="flex rounded-md border p-0.5" role="tablist" aria-label="Status">
            {STATUS_TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={status === t.id} onClick={() => setStatus(t.id)} className={cn('rounded px-3 py-1 text-sm', status === t.id && 'bg-muted font-medium')}>
                {t.label}
              </button>
            ))}
          </div>
          <NativeSelect aria-label="Kind" className="w-auto" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Every kind</option>
            {Object.entries(KIND_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </NativeSelect>
          {repoId && (
            <Button variant="ghost" size="sm" onClick={() => setRepoId('')}>
              All repositories
            </Button>
          )}
        </div>
        {recs.error && <Alert tone="destructive">{recs.error.message}</Alert>}
        {recs.data?.length === 0 && <p className="text-sm text-muted-foreground">{status === 'open' ? 'Nothing open. ' : ''}No recommendations here.</p>}
        <ul className="space-y-3">
          {recs.data?.map((r) => (
            <RecommendationCard key={r.id} rec={r} slug={slug} />
          ))}
        </ul>
      </section>
    </div>
  );
}

function RecommendationCard({ rec: r, slug }: { rec: Rec; slug: string }) {
  const utils = trpc.useUtils();
  const router = useRouter();
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState('');
  const refresh = () => utils.groupAgent.invalidate();
  const createTask = trpc.groupAgent.createTask.useMutation({
    onSuccess: ({ key }) => {
      toast.success(`Created ${key}`, { action: { label: 'Open', onClick: () => router.push(`/o/${slug}/tasks/${key}`) } });
      void refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const dismiss = trpc.groupAgent.dismiss.useMutation({
    onSuccess: () => {
      toast.success('Dismissed');
      setDismissing(false);
      void refresh();
    },
  });
  const reopen = trpc.groupAgent.reopen.useMutation({ onSuccess: refresh });

  return (
    <li className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <SeverityBadge severity={r.severity} />
            <span>{KIND_LABEL[r.kind] ?? r.kind}</span>
            <span>·</span>
            <span className="truncate">{r.repo ?? 'Across the organization'}</span>
          </div>
          <h3 className="font-medium [overflow-wrap:anywhere]">{r.title}</h3>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground" title={`First seen ${new Date(r.firstSeenAt).toLocaleString()}`}>
          seen {relativeTime(r.lastSeenAt)}
        </span>
      </div>
      <div className="mt-2 text-sm">
        <Markdown text={r.bodyMd} />
      </div>
      {r.status === 'dismissed' && r.dismissedReason && <p className="mt-2 text-xs text-muted-foreground">Dismissed: {r.dismissedReason}</p>}
      {r.taskKey && (
        <p className="mt-2 text-sm">
          Task:{' '}
          <Link href={`/o/${slug}/tasks/${r.taskKey}`} className="font-mono underline">
            {r.taskKey}
          </Link>
          {r.taskStatus && <span className="text-muted-foreground"> ({r.taskStatus.replaceAll('_', ' ')})</span>}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {r.status === 'open' && !dismissing && (
          <>
            {r.repoId && (
              <Button size="sm" onClick={() => createTask.mutate({ id: r.id })} disabled={createTask.isPending}>
                Create task
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setDismissing(true)}>
              Dismiss
            </Button>
          </>
        )}
        {dismissing && (
          <form
            className="flex w-full flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (reason.trim()) dismiss.mutate({ id: r.id, reason });
            }}
          >
            <Input autoFocus aria-label="Why dismiss it?" placeholder="Why? (e.g. pinned on purpose)" className="min-w-0 flex-1" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
            <Button type="submit" size="sm" disabled={!reason.trim() || dismiss.isPending}>
              Dismiss
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setDismissing(false)}>
              Cancel
            </Button>
          </form>
        )}
        {(r.status === 'dismissed' || (r.status === 'task_created' && (!r.taskStatus || ['cancelled', 'rejected', 'failed'].includes(r.taskStatus)))) && (
          <Button size="sm" variant="ghost" onClick={() => reopen.mutate({ id: r.id })} disabled={reopen.isPending}>
            Reopen
          </Button>
        )}
      </div>
    </li>
  );
}
