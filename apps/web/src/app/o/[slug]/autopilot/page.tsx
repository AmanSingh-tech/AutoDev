'use client';

import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, cn, Input, NativeSelect } from '@autodev/ui';
import { CircleCheck, GitPullRequestDraft, Lightbulb, MoonStar, Play, Square, Trash2, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/task-bits';
import { relativeTime, usd } from '@/lib/format';
import { trpc, type RouterOutputs } from '@/lib/trpc';

type Data = RouterOutputs['autopilot']['get'];
type Run = Data['runs'][number];

const DAYS = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [7, 'Sun'],
] as const;
const STOP: Record<string, string> = {
  window_ended: 'the window ended',
  queue_empty: 'the queue was empty',
  budget: 'the nightly spend cap was reached',
  max_tasks: 'the task limit was reached',
  stopped: 'you stopped it',
};
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const minutes = (v: string) => {
  const [h, m] = v.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const when = (d: Date | string, tz?: string) => new Date(d).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });

/** Autopilot: queue tasks, the agent works through them in your window, and you review in the morning. */
export default function AutopilotPage() {
  const { slug } = useParams<{ slug: string }>();
  const utils = trpc.useUtils();
  const q = trpc.autopilot.get.useQuery(undefined, { refetchInterval: 20_000 });
  const refresh = () => utils.autopilot.invalidate();
  const onError = (e: { message: string }) => toast.error(e.message);
  const run = trpc.autopilot.runUntilMorning.useMutation({ onSuccess: (r) => (toast.success(`Autopilot is on until ${when(r.until)}`), refresh()), onError });
  const stop = trpc.autopilot.stop.useMutation({ onSuccess: () => (toast.success('Autopilot stopped. A task already running will finish.'), refresh()), onError });
  const allow = trpc.autopilot.setAllowed.useMutation({ onSuccess: refresh, onError });

  if (!q.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const d = q.data;
  const live = d.runs.find((r) => r.status === 'running');
  const lastDone = d.runs.find((r) => r.status === 'done' && r.tasks.length > 0);

  return (
    <div className="space-y-8">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <MoonStar aria-hidden className="size-6 text-primary" />
            Autopilot
          </span>
        }
        description="Queue tasks before you leave. The agent works through them on its own, approving its own plans, writing down any assumptions, and opening draft pull requests for you to review in the morning."
        actions={
          d.inWindow ? (
            <Button variant="outline" onClick={() => stop.mutate()} disabled={stop.isPending}>
              <Square aria-hidden />
              Stop now
            </Button>
          ) : (
            <Button onClick={() => run.mutate()} disabled={run.isPending || !d.allowed}>
              <Play aria-hidden />
              Run until morning
            </Button>
          )
        }
      />

      {!d.allowed && <Alert tone="warning">An admin has turned Autopilot off for this organization.</Alert>}
      <StatusStrip d={d} live={live} />

      {live && live.tasks.length > 0 && <MorningReview slug={slug} run={live} title="This session so far" onChange={refresh} />}
      {lastDone && <MorningReview slug={slug} run={lastDone} title="Morning review" onChange={refresh} />}

      <Queue slug={slug} queue={d.queue} onChange={refresh} />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Schedule d={d} onSaved={refresh} />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lightbulb aria-hidden className="size-4 text-warning" />
              How it stays safe
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5 text-sm text-muted-foreground">
            <p>Pull requests are always drafts. Nothing merges, and nothing is pushed to your main branch.</p>
            <p>When the agent would ask you something, it picks the safest option and lists it as an assumption. It never changes files outside the approved plan.</p>
            <p>One task at a time, within your nightly spend cap and task limit. A task still running at the end of the window finishes; no new ones start.</p>
            <p>Your builder has to stay online: a team builder or a machine that doesn’t sleep works best.</p>
          </CardContent>
        </Card>
      </div>

      <History runs={d.runs.filter((r) => r !== lastDone && r.status === 'done')} />

      {d.isAdmin && (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={d.allowed} disabled={allow.isPending} onChange={(e) => allow.mutate({ allowed: e.target.checked })} />
          Allow Autopilot in this organization (admins)
        </label>
      )}
    </div>
  );
}

function StatusStrip({ d, live }: { d: Data; live: Run | undefined }) {
  const tz = d.settings.timezone;
  const text = live
    ? `Running now: ${live.tasksStarted} task${live.tasksStarted === 1 ? '' : 's'} started, until ${when(live.endsAt, tz)}.`
    : d.inWindow
      ? 'On: it will start your next queued task within a couple of minutes.'
      : d.settings.enabled && d.nextStart
        ? `On. Next run ${when(d.nextStart, tz)} (${tz}).`
        : 'Off. Turn on a schedule below, or press Run until morning.';
  return (
    <div className={cn('flex items-center gap-3 rounded-xl border px-4 py-3 text-sm', live || d.inWindow ? 'border-primary/30 bg-accent/60 text-accent-foreground' : 'bg-card')}>
      <span aria-hidden className={cn('relative flex size-2.5 shrink-0', !(live || d.inWindow) && 'opacity-40')}>
        {(live || d.inWindow) && <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:animate-none" />}
        <span className={cn('relative inline-flex size-2.5 rounded-full', live || d.inWindow ? 'bg-primary' : d.settings.enabled ? 'bg-success' : 'bg-muted-foreground')} />
      </span>
      {text}
      {live?.stopReason && <span className="text-muted-foreground">No more tasks this session: {STOP[live.stopReason] ?? live.stopReason}.</span>}
    </div>
  );
}

function MorningReview({ slug, run, title, onChange }: { slug: string; run: Run; title: string; onChange: () => void }) {
  const reviewed = trpc.autopilot.reviewed.useMutation();
  useEffect(() => {
    if (!run.reviewedAt && run.endedAt) reviewed.mutate({ runId: run.id });
    // Once per run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);
  const total = run.tasks.reduce((s, t) => s + t.costUsd, 0);
  return (
    <section aria-labelledby={`review-${run.id}`} className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id={`review-${run.id}`} className="text-lg font-semibold tracking-tight">
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">
            {run.endedAt ? `Finished ${relativeTime(run.endedAt)}` : 'Running'} · {run.tasks.length} task{run.tasks.length === 1 ? '' : 's'} · {usd(total)}
            {run.stopReason && ` · stopped because ${STOP[run.stopReason] ?? run.stopReason}`}
          </p>
        </div>
        {!run.reviewedAt && run.endedAt && <Badge variant="accent">New</Badge>}
      </div>
      <ul className="space-y-3">
        {run.tasks.map((t) => (
          <ReviewCard key={t.key} slug={slug} t={t} onChange={onChange} />
        ))}
      </ul>
    </section>
  );
}

function ReviewCard({ slug, t, onChange }: { slug: string; t: Run['tasks'][number]; onChange: () => void }) {
  const [notes, setNotes] = useState<string | null>(null);
  const onError = (e: { message: string }) => toast.error(e.message);
  const ready = trpc.autopilot.markReady.useMutation({ onSuccess: () => (toast.success(`${t.key}: ready for review`), onChange()), onError });
  const back = trpc.autopilot.sendBack.useMutation({ onSuccess: (r) => (toast.success(`${r.key} queued for tonight with your notes`), setNotes(null), onChange()), onError });
  const discard = trpc.autopilot.discard.useMutation({ onSuccess: () => (toast.success(`${t.key} discarded`), onChange()), onError });
  const open = t.prState === 'open';
  const busy = ready.isPending || back.isPending || discard.isPending;
  return (
    <li className="rounded-xl border bg-card p-4 shadow-card">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <Link href={`/o/${slug}/tasks/${t.key}`} className="font-medium hover:underline">
            {t.title}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{t.key}</span>
            <span>{t.repo}</span>
            <StatusBadge status={t.status} />
            {t.prNumber && (
              <Badge variant={t.prDraft ? 'outline' : 'info'}>
                <GitPullRequestDraft aria-hidden />
                PR #{t.prNumber} {t.prState === 'open' ? (t.prDraft ? 'draft' : 'ready') : t.prState}
              </Badge>
            )}
            {t.decisions > 0 && (
              <Badge variant="warning">
                {t.decisions} assumption{t.decisions === 1 ? '' : 's'}
              </Badge>
            )}
            <span>{usd(t.costUsd)}</span>
          </div>
        </div>
        {open && (
          <div className="flex flex-wrap gap-2">
            {t.prDraft && (
              <Button size="sm" disabled={busy} onClick={() => ready.mutate({ key: t.key })}>
                <CircleCheck aria-hidden />
                Ready for review
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setNotes(notes === null ? '' : null)}>
              <Undo2 aria-hidden />
              Send back
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => confirm(`Close the pull request and cancel ${t.key}?`) && discard.mutate({ key: t.key })}>
              <Trash2 aria-hidden />
              Discard
            </Button>
          </div>
        )}
      </div>
      {notes !== null && (
        <form
          className="mt-3 space-y-2 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            back.mutate({ key: t.key, notes });
          }}
        >
          <label className="text-sm font-medium" htmlFor={`notes-${t.key}`}>
            What should change? A follow-up task goes into tonight’s queue on the same branch.
          </label>
          <textarea id={`notes-${t.key}`} rows={3} className="w-full rounded-md border bg-card px-3 py-2 text-sm" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <Button size="sm" type="submit" disabled={back.isPending || notes.trim().length < 3}>
            Queue the follow-up
          </Button>
        </form>
      )}
    </li>
  );
}

function Queue({ slug, queue, onChange }: { slug: string; queue: Data['queue']; onChange: () => void }) {
  const unqueue = trpc.autopilot.queue.useMutation({ onSuccess: onChange, onError: (e) => toast.error(e.message) });
  return (
    <section aria-labelledby="queue" className="space-y-3">
      <h2 id="queue" className="text-lg font-semibold tracking-tight">
        Tonight’s queue
      </h2>
      {queue.length === 0 ? (
        <EmptyState icon={MoonStar} title="Nothing queued" action={<Button asChild variant="outline"><Link href={`/o/${slug}/tasks`}>Pick tasks</Link></Button>}>
          Open a draft task and press <span className="font-medium text-foreground">Run on Autopilot</span>. Urgent and high-priority tasks go first.
        </EmptyState>
      ) : (
        <ol className="divide-y overflow-hidden rounded-xl border bg-card shadow-card">
          {queue.map((t, i) => (
            <li key={t.key} className="flex items-center gap-3 px-4 py-3">
              <span className="w-5 text-sm tabular-nums text-muted-foreground">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <Link href={`/o/${slug}/tasks/${t.key}`} className="block truncate text-sm font-medium hover:underline">
                  {t.title}
                </Link>
                <div className="text-xs text-muted-foreground">
                  <span className="font-mono">{t.key}</span> · {t.repo} · {t.priority}
                </div>
              </div>
              <Button size="sm" variant="ghost" disabled={unqueue.isPending} onClick={() => unqueue.mutate({ key: t.key, on: false })}>
                Remove
              </Button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Schedule({ d, onSaved }: { d: Data; onSaved: () => void }) {
  const browserTz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
  const [f, setF] = useState(() => ({ ...d.settings, timezone: d.settings.timezone === 'UTC' && !d.settings.enabled ? browserTz : d.settings.timezone }));
  const save = trpc.autopilot.save.useMutation({ onSuccess: () => (toast.success('Autopilot schedule saved'), onSaved()), onError: (e) => toast.error(e.message) });
  const listed = typeof Intl !== 'undefined' && 'supportedValuesOf' in Intl ? (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone') : [];
  // The browser's list may leave out the saved zone (e.g. "UTC"); keep it, or the select would silently change it.
  const zones = listed.includes(f.timezone) ? listed : [f.timezone, ...listed];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Schedule</CardTitle>
        <CardDescription>When Autopilot may run on its own. A window that ends earlier than it starts runs overnight.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ enabled: f.enabled, timezone: f.timezone, startMinute: f.startMinute, endMinute: f.endMinute, days: f.days, nightlyBudgetUsd: f.nightlyBudgetUsd, maxTasks: f.maxTasks });
          }}
        >
          <label className="flex items-center gap-2.5 text-sm font-medium">
            <input type="checkbox" checked={f.enabled} disabled={!d.allowed} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
            Run on a schedule
          </label>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="text-sm">
              From
              <Input className="mt-1" type="time" value={hhmm(f.startMinute)} onChange={(e) => setF({ ...f, startMinute: minutes(e.target.value) })} />
            </label>
            <label className="text-sm">
              Until
              <Input className="mt-1" type="time" value={hhmm(f.endMinute)} onChange={(e) => setF({ ...f, endMinute: minutes(e.target.value) })} />
            </label>
            <label className="text-sm">
              Time zone
              <NativeSelect className="mt-1" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </NativeSelect>
            </label>
          </div>
          <fieldset>
            <legend className="mb-1.5 text-sm">Starting on</legend>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map(([n, label]) => {
                const on = f.days.includes(n);
                return (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setF({ ...f, days: on ? f.days.filter((x) => x !== n) : [...f.days, n] })}
                    className={cn('h-8 rounded-md border px-3 text-sm transition-colors', on ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-secondary')}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              Nightly spend cap (USD)
              <Input className="mt-1" type="number" min={1} step={1} value={f.nightlyBudgetUsd} onChange={(e) => setF({ ...f, nightlyBudgetUsd: Number(e.target.value) })} />
            </label>
            <label className="text-sm">
              Most tasks per night
              <Input className="mt-1" type="number" min={1} max={50} value={f.maxTasks} onChange={(e) => setF({ ...f, maxTasks: Number(e.target.value) })} />
            </label>
          </div>
          <Button type="submit" disabled={save.isPending}>
            Save schedule
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function History({ runs }: { runs: Run[] }) {
  if (!runs.length) return null;
  return (
    <section aria-labelledby="history" className="space-y-3">
      <h2 id="history" className="text-lg font-semibold tracking-tight">
        Earlier runs
      </h2>
      <ul className="divide-y overflow-hidden rounded-xl border bg-card text-sm shadow-card">
        {runs.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
            <span className="font-medium">{new Date(r.startedAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
            <span className="text-muted-foreground">
              {r.tasksStarted} task{r.tasksStarted === 1 ? '' : 's'} · {r.tasks.filter((t) => t.prNumber).length} PR{r.tasks.filter((t) => t.prNumber).length === 1 ? '' : 's'}
            </span>
            {r.stopReason && <span className="text-muted-foreground">stopped: {STOP[r.stopReason] ?? r.stopReason}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
