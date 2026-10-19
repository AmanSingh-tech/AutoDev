'use client';

import { Alert, Button, Table, TBody, TD, TH, THead, TR } from '@autodev/ui';
import { useState } from 'react';
import { DailyCostChart } from '@/components/daily-cost-chart';
import { StatTile } from '@/components/stat-tile';
import { int, tokens, usd } from '@/lib/format';
import { trpc, type RouterOutputs } from '@/lib/trpc';

type Totals = Pick<RouterOutputs['usage']['summary']['total'], 'calls' | 'inputTokens' | 'outputTokens' | 'costUsd'>;

function shift(month: string, by: number) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function UsagePage() {
  const [month, setMonth] = useState(thisMonth);
  const q = trpc.usage.summary.useQuery({ month });
  const s = q.data;
  const label = new Date(`${month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">AI usage</h1>
          <p className="text-sm text-muted-foreground">{s?.scope === 'mine' ? 'Your usage.' : 'Usage across the organization.'} Metered from the provider’s own token counts.</p>
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Month">
          <Button variant="outline" size="sm" onClick={() => setMonth(shift(month, -1))} aria-label="Previous month">
            ←
          </Button>
          <span className="w-36 text-center text-sm font-medium">{label}</span>
          <Button variant="outline" size="sm" onClick={() => setMonth(shift(month, 1))} disabled={month >= thisMonth()} aria-label="Next month">
            →
          </Button>
        </div>
      </div>

      {s && (
        <>
          {s.total.unpricedCalls > 0 && (
            <Alert>
              {int(s.total.unpricedCalls)} calls used a model with no price, so their cost is shown as $0. Add the model under Models & prices.
            </Alert>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile hero label="Cost" value={usd(s.total.costUsd, { compact: true })} hint={`${int(s.total.calls)} LLM calls`} />
            <StatTile label="Input tokens" value={tokens(s.total.inputTokens)} />
            <StatTile label="Output tokens" value={tokens(s.total.outputTokens)} />
            <StatTile label="Cache writes" value={tokens(s.total.cacheWriteTokens)} />
            <StatTile label="Cache reads" value={tokens(s.total.cacheReadTokens)} />
          </div>
          <DailyCostChart month={s.month} daily={s.daily} />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Breakdown title="By member" rows={s.byUser} name={(r) => r.login ?? 'System'} />
            <Breakdown title="By repository" rows={s.byRepo} name={(r) => r.fullName ?? 'No repository'} />
            <Breakdown title="By model" rows={s.byModel} name={(r) => r.model} mono />
          </div>
        </>
      )}
    </div>
  );
}

function Breakdown<T extends Totals>({ title, rows, name, mono }: { title: string; rows: T[]; name: (r: T) => string; mono?: boolean }) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="mb-2 text-sm font-medium">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No usage.</p>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH className="text-right">Calls</TH>
              <TH className="text-right">Tokens in / out</TH>
              <TH className="text-right">Cost</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((r, i) => (
              <TR key={i}>
                <TD className={mono ? 'font-mono text-xs' : undefined}>{name(r)}</TD>
                <TD className="text-right tabular-nums">{int(r.calls)}</TD>
                <TD className="text-right tabular-nums">
                  {tokens(r.inputTokens)} / {tokens(r.outputTokens)}
                </TD>
                <TD className="text-right font-medium tabular-nums">{usd(r.costUsd)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </section>
  );
}
