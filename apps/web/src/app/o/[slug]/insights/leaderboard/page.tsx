'use client';

import { Alert, Avatar, Button, cn, NativeSelect, Table, TBody, TD, TH, THead, TR } from '@autodev/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { int, relativeTime, tokens, usd } from '@/lib/format';
import { trpc } from '@/lib/trpc';

const BADGE_LABEL: Record<string, string> = {
  first_merge: 'First merge',
  ten_merged: '10 merged PRs',
  clean_first_pass: 'Clean first pass',
  efficient: 'Efficient',
};
const PERIOD_LABEL = { week: 'Week', month: 'Month', quarter: 'Quarter' } as const;

function periodTitle(period: 'week' | 'month' | 'quarter', start: string) {
  const d = new Date(`${start}T00:00:00Z`);
  if (period === 'week') return `Week of ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
  if (period === 'month') return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

export default function LeaderboardPage() {
  const { slug } = useParams<{ slug: string }>();
  const settings = trpc.insights.settings.useQuery();
  const [period, setPeriod] = useState<'week' | 'month' | 'quarter'>('month');
  const [offset, setOffset] = useState(0);
  const [tab, setTab] = useState<'impact' | 'tokens'>('impact');
  // "org", "team:<id>" or "repo:<id>". Team leads who may only see their teams start on the first one.
  const [scopeKey, setScopeKey] = useState<string | null>(null);
  const defaultScope = settings.data && !settings.data.isAdmin && settings.data.leaderboardVisibility === 'team_leads' ? `team:${settings.data.leadTeamIds[0]}` : 'org';
  const key = scopeKey ?? defaultScope;
  const [scope, scopeId] = key.split(':') as ['org' | 'team' | 'repo', string | undefined];
  const q = trpc.insights.leaderboard.useQuery({ period, offset, tab, scope, ...(scopeId ? { scopeId } : {}) }, { enabled: !!settings.data?.canSeeLeaderboard, retry: false });
  const b = q.data;

  if (settings.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!settings.data?.canSeeLeaderboard)
    return (
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">Leaderboard</h1>
        <p className="text-sm text-muted-foreground">
          {settings.data?.leaderboardVisibility === 'team_leads' ? 'The leaderboard is open to admins and team leads in this organization.' : 'Only admins can see the leaderboard in this organization.'}
        </p>
      </div>
    );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Leaderboard</h1>
          <p className="text-sm text-muted-foreground">
            Impact = merged PRs × (0.5 + 0.5 × first-pass approval rate). Ties go to the lower cost per PR.
            {b?.computedAt ? ` Updated ${relativeTime(b.computedAt)}.` : ''}
          </p>
        </div>
        {settings.data.canSeeOverview && (
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/insights`}>Insights</Link>
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
        <div className="flex rounded-md border p-0.5" role="tablist" aria-label="Rank by">
          {(['impact', 'tokens'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('rounded px-3 py-1 text-sm', tab === t && 'bg-muted font-medium')}>
              {t === 'impact' ? 'Impact' : 'Tokens'}
            </button>
          ))}
        </div>
        <NativeSelect
          aria-label="Period"
          className="w-auto"
          value={period}
          onChange={(e) => {
            setPeriod(e.target.value as typeof period);
            setOffset(0);
          }}
        >
          {(['week', 'month', 'quarter'] as const).map((p) => (
            <option key={p} value={p}>
              {PERIOD_LABEL[p]}
            </option>
          ))}
        </NativeSelect>
        <div className="flex items-center gap-1" role="group" aria-label="Which period">
          <Button variant="outline" size="sm" aria-label="Previous period" onClick={() => setOffset(offset + 1)} disabled={offset >= 24}>
            ←
          </Button>
          <span className="min-w-36 text-center text-sm font-medium">{b ? periodTitle(period, b.range.start) : '…'}</span>
          <Button variant="outline" size="sm" aria-label="Next period" onClick={() => setOffset(offset - 1)} disabled={offset === 0}>
            →
          </Button>
        </div>
        {b && (b.scopes.org || b.scopes.teams.length + b.scopes.repos.length > 1) && (
          <NativeSelect aria-label="Scope" className="w-auto max-w-[16rem]" value={key} onChange={(e) => setScopeKey(e.target.value)}>
            {b.scopes.org && <option value="org">Whole organization</option>}
            {b.scopes.teams.map((t) => (
              <option key={t.id} value={`team:${t.id}`}>
                Team {t.name}
              </option>
            ))}
            {b.scopes.repos.map((r) => (
              <option key={r.id} value={`repo:${r.id}`}>
                {r.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </div>

      {q.error && <Alert tone="destructive">{q.error.message}</Alert>}
      {b && b.rows.length === 0 && <p className="text-sm text-muted-foreground">Nobody has activity in this period yet. Boards are rebuilt nightly.</p>}
      {b && b.rows.length > 0 && (
        <Table>
          <THead>
            <TR>
              <TH className="w-12 text-right">#</TH>
              <TH className="min-w-[12rem]">Person</TH>
              {tab === 'impact' ? (
                <>
                  <TH className="text-right">Impact</TH>
                  <TH className="text-right">Merged PRs</TH>
                  <TH className="text-right">First pass</TH>
                  {!b.costHidden && <TH className="text-right">Cost per PR</TH>}
                </>
              ) : (
                <>
                  <TH className="text-right">Tokens</TH>
                  {!b.costHidden && <TH className="text-right">Cost</TH>}
                  <TH className="text-right">Merged PRs</TH>
                </>
              )}
            </TR>
          </THead>
          <TBody>
            {b.rows.map((r) => (
              <TR key={r.userId} className={cn(r.isYou && 'bg-muted/40')}>
                <TD className="text-right tabular-nums text-muted-foreground">{r.rank}</TD>
                <TD>
                  <div className="flex items-center gap-2">
                    <Avatar src={r.avatarUrl} alt={r.login} className="h-6 w-6 shrink-0" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium" title={r.name ?? r.login}>
                        {r.login}
                        {r.isYou && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}
                      </span>
                      {r.badges.length > 0 && (
                        <span className="mt-0.5 flex flex-wrap gap-1">
                          {r.badges.map((badge) => (
                            <span key={badge} className="rounded border px-1.5 text-[11px] text-muted-foreground">
                              {BADGE_LABEL[badge] ?? badge}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                  </div>
                </TD>
                {tab === 'impact' ? (
                  <>
                    <TD className="text-right font-medium tabular-nums">{r.impactScore.toFixed(2)}</TD>
                    <TD className="text-right tabular-nums">{int(r.prsMerged)}</TD>
                    <TD className="text-right tabular-nums">{r.approvalRate === null ? '—' : `${Math.round(r.approvalRate * 100)}%`}</TD>
                    {!b.costHidden && <TD className="text-right tabular-nums">{r.costPerPrUsd === null ? '—' : usd(r.costPerPrUsd)}</TD>}
                  </>
                ) : (
                  <>
                    <TD className="text-right font-medium tabular-nums">{tokens(r.tokens)}</TD>
                    {!b.costHidden && <TD className="text-right tabular-nums">{usd(r.costUsd ?? 0)}</TD>}
                    <TD className="text-right tabular-nums">{int(r.prsMerged)}</TD>
                  </>
                )}
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
