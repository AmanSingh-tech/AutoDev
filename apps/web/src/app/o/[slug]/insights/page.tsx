'use client';

import { Alert, Button, cn, NativeSelect, Table, TBody, TD, TH, THead, TR } from '@autodev/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { BarList, TrendChart } from '@/components/insights-charts';
import { StatTile } from '@/components/stat-tile';
import { int, relativeTime, tokens, usd } from '@/lib/format';
import { trpc, type RouterOutputs } from '@/lib/trpc';
import { useOrg } from '../org-shell';

type Overview = RouterOutputs['insights']['overview'];
type Kpis = Overview['totals'];

const RANGES = [
  { id: '30', label: 'Last 30 days', days: 30, bucket: 'day' as const },
  { id: '90', label: 'Last 90 days', days: 90, bucket: 'week' as const },
  { id: '365', label: 'Last 12 months', days: 365, bucket: 'month' as const },
];
const MEASURES = [
  { id: 'cost', label: 'Cost', pick: (k: Kpis) => k.costUsd ?? 0, format: (v: number) => usd(v, { compact: true }), needsCost: true },
  { id: 'prs', label: 'Merged PRs', pick: (k: Kpis) => k.prsMerged, format: int, needsCost: false },
  { id: 'tasks', label: 'Tasks created', pick: (k: Kpis) => k.tasksCreated, format: int, needsCost: false },
  { id: 'tokens', label: 'Tokens', pick: (k: Kpis) => k.tokens, format: tokens, needsCost: false },
] as const;

const day = (d: Date) => d.toISOString().slice(0, 10);
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const hours = (v: number | null) => (v === null ? '—' : v < 1 ? `${Math.max(1, Math.round(v * 60))} min` : v < 48 ? `${v.toFixed(1)} h` : `${(v / 24).toFixed(1)} d`);
const plural = (n: number, one: string, many: string) => `${int(n)} ${n === 1 ? one : many}`;

/** Every bucket start in [from, to], so empty days, weeks or months still get a slot on the axis. */
function buckets(from: Date, to: Date, bucket: 'day' | 'week' | 'month'): string[] {
  const out: string[] = [];
  let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  if (bucket === 'week') d = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000);
  if (bucket === 'month') d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  while (d <= to) {
    out.push(day(d));
    d = bucket === 'month' ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)) : new Date(d.getTime() + (bucket === 'week' ? 7 : 1) * 86_400_000);
  }
  return out;
}

export default function InsightsPage() {
  const { slug } = useParams<{ slug: string }>();
  const org = useOrg();
  const settings = trpc.insights.settings.useQuery();
  const teamsQ = trpc.teams.list.useQuery();
  const [rangeId, setRangeId] = useState('30');
  const [teamId, setTeamId] = useState('');
  const [measure, setMeasure] = useState<(typeof MEASURES)[number]['id']>('prs');
  const [breakdown, setBreakdown] = useState<'byUser' | 'byTeam' | 'byRepo'>('byUser');
  const range = RANGES.find((r) => r.id === rangeId)!;
  const isAdmin = settings.data?.isAdmin ?? false;
  // Team leads only ever look at a team they lead; default to the first one.
  const leadTeams = (teamsQ.data ?? []).filter((t) => settings.data?.leadTeamIds.includes(t.id));
  const effectiveTeam = teamId || (isAdmin ? '' : (leadTeams[0]?.id ?? ''));
  const to = new Date();
  const from = new Date(to.getTime() - (range.days - 1) * 86_400_000);
  const q = trpc.insights.overview.useQuery(
    { from: day(from), to: day(to), bucket: range.bucket, ...(effectiveTeam ? { teamId: effectiveTeam } : {}) },
    { enabled: !!settings.data?.canSeeOverview && (isAdmin || !!effectiveTeam) },
  );
  const recompute = trpc.insights.recompute.useMutation({ onSuccess: () => toast.success('Recomputing. Figures update in a minute or two.') });

  if (settings.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!settings.data?.canSeeOverview)
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">Insights</h1>
        <p className="text-sm text-muted-foreground">Insights are for admins and team leads.</p>
        {settings.data?.canSeeLeaderboard && (
          <Button asChild variant="outline">
            <Link href={`/o/${slug}/insights/leaderboard`}>Open the leaderboard</Link>
          </Button>
        )}
      </div>
    );

  const o = q.data;
  const teamOptions = isAdmin ? (teamsQ.data ?? []) : leadTeams;
  const measures = MEASURES.filter((m) => !(m.needsCost && o?.costHidden));
  const m = measures.find((x) => x.id === measure) ?? measures[0]!;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Insights</h1>
          <p className="text-sm text-muted-foreground">
            {effectiveTeam ? `Team ${teamOptions.find((t) => t.id === effectiveTeam)?.name ?? ''}` : org.name}. Rebuilt nightly
            {o?.dataThrough ? `; last ${relativeTime(o.dataThrough)}` : ''}. Days are UTC.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/insights/leaderboard`}>Leaderboard</Link>
          </Button>
          {isAdmin && (
            <Button variant="outline" size="sm" onClick={() => recompute.mutate()} disabled={recompute.isPending}>
              Recompute now
            </Button>
          )}
        </div>
      </div>

      {/* Filters: one row, above everything they filter. */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filters">
        <NativeSelect aria-label="Date range" className="w-auto" value={rangeId} onChange={(e) => setRangeId(e.target.value)}>
          {RANGES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </NativeSelect>
        {(isAdmin ? teamOptions.length > 0 : teamOptions.length > 1) && (
          <NativeSelect aria-label="Team" className="w-auto" value={effectiveTeam} onChange={(e) => setTeamId(e.target.value)}>
            {isAdmin && <option value="">Whole organization</option>}
            {teamOptions.map((t) => (
              <option key={t.id} value={t.id}>
                Team {t.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </div>

      {q.error && <Alert tone="destructive">{q.error.message}</Alert>}
      {!o && !q.error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {o && (
        <>
          {!o.dataThrough && (
            <Alert>No figures yet: they're built nightly. {isAdmin ? 'Use Recompute now to build them right away.' : 'Check back tomorrow.'}</Alert>
          )}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {o.costHidden ? (
              <StatTile hero label="Merged PRs" value={int(o.totals.prsMerged)} hint={`${plural(o.totals.tasksResolved, 'task', 'tasks')} resolved`} />
            ) : (
              <StatTile hero label="Cost" value={usd(o.totals.costUsd ?? 0, { compact: true })} hint={plural(o.totals.prsMerged, 'merged PR', 'merged PRs')} />
            )}
            {!o.costHidden && <StatTile label="Cost per merged PR" value={o.totals.costPerMergedPrUsd === null ? '—' : usd(o.totals.costPerMergedPrUsd)} />}
            <StatTile label="First-pass approval" value={pct(o.totals.firstPassRate)} hint={o.totals.docsReviewed ? `${plural(o.totals.docsReviewed, 'plan or design', 'plans and designs')} reviewed` : 'Nothing reviewed'} />
            <StatTile label="Median time to merge" value={hours(o.totals.medianMergeHours)} hint="Task created → PR merged" />
            <StatTile label="Average prompt score" value={o.totals.avgPromptScore === null ? '—' : `${Math.round(o.totals.avgPromptScore)}/100`} />
            <StatTile label="Tasks" value={`${int(o.totals.tasksCreated)} → ${int(o.totals.tasksResolved)}`} hint="Created → resolved" />
            <StatTile label="Tokens" value={tokens(o.totals.tokens)} />
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Measure">
              {measures.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  role="radio"
                  aria-checked={m.id === x.id}
                  onClick={() => setMeasure(x.id)}
                  className={cn('rounded-md px-3 py-1.5 text-sm hover:bg-muted', m.id === x.id && 'bg-muted font-medium')}
                >
                  {x.label}
                </button>
              ))}
            </div>
            <TrendChart
              title={`${m.label} per ${range.bucket}`}
              points={(() => {
                const by = new Map(o.series.map((s) => [s.bucket, m.pick(s)]));
                return buckets(from, to, range.bucket).map((b) => ({ label: b, value: by.get(b) ?? 0 }));
              })()}
              format={m.format}
              empty="Nothing in this range."
            />
          </div>

          {!o.costHidden && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <BarList title="Spend by repository" rows={o.byRepo.map((r) => ({ label: r.label, value: r.costUsd ?? 0 }))} format={(v) => usd(v)} empty="No spend in this range." />
              <BarList title="Spend by model" rows={o.byModel.map((r) => ({ label: r.model, value: r.costUsd }))} format={(v) => usd(v)} empty="No spend in this range." />
            </div>
          )}

          <Breakdown o={o} which={breakdown} onChange={setBreakdown} />
          {isAdmin && (
            <p className="text-sm text-muted-foreground">
              Budgets and this month's spend per person are on{' '}
              <Link href={`/o/${slug}/settings/budgets`} className="underline">
                Budgets
              </Link>{' '}
              and{' '}
              <Link href={`/o/${slug}/usage`} className="underline">
                Usage
              </Link>
              .
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Breakdown({ o, which, onChange }: { o: Overview; which: 'byUser' | 'byTeam' | 'byRepo'; onChange: (w: 'byUser' | 'byTeam' | 'byRepo') => void }) {
  const rows = o[which];
  return (
    <section className="space-y-2" aria-label="Breakdown">
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Break down by">
        {(
          [
            ['byUser', 'People'],
            ['byTeam', 'Teams'],
            ['byRepo', 'Repositories'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={which === id} onClick={() => onChange(id)} className={cn('rounded-md px-3 py-1.5 text-sm hover:bg-muted', which === id && 'bg-muted font-medium')}>
            {label}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing in this range.</p>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH className="min-w-[10rem]">{which === 'byUser' ? 'Person' : which === 'byTeam' ? 'Team' : 'Repository'}</TH>
              <TH className="text-right">Merged PRs</TH>
              <TH className="text-right">Tasks</TH>
              <TH className="text-right">First pass</TH>
              <TH className="text-right">Median to merge</TH>
              <TH className="text-right">Prompt score</TH>
              {!o.costHidden && <TH className="text-right">Cost</TH>}
              {!o.costHidden && <TH className="text-right">Per PR</TH>}
            </TR>
          </THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.id}>
                <TD className="max-w-[16rem] truncate" title={r.label}>
                  {r.label}
                </TD>
                <TD className="text-right tabular-nums">{int(r.prsMerged)}</TD>
                <TD className="whitespace-nowrap text-right tabular-nums">
                  {int(r.tasksCreated)} → {int(r.tasksResolved)}
                </TD>
                <TD className="text-right tabular-nums">{pct(r.firstPassRate)}</TD>
                <TD className="whitespace-nowrap text-right tabular-nums">{hours(r.medianMergeHours)}</TD>
                <TD className="text-right tabular-nums">{r.avgPromptScore === null ? '—' : Math.round(r.avgPromptScore)}</TD>
                {!o.costHidden && <TD className="text-right tabular-nums">{usd(r.costUsd ?? 0)}</TD>}
                {!o.costHidden && <TD className="text-right tabular-nums">{r.costPerMergedPrUsd === null ? '—' : usd(r.costPerMergedPrUsd)}</TD>}
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </section>
  );
}
