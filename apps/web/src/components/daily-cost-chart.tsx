'use client';

import { Button, Table, TBody, TD, TH, THead, TR } from '@autodev/ui';
import { useState } from 'react';
import { usd } from '@/lib/format';

/**
 * Daily spend for one month. Single series, so no legend (the title names it). Bars are capped at
 * 24px with 4px rounded tops and a 2px gap. The whole day column is the hover/focus target, and a
 * table view keeps every value reachable without hovering.
 */
export function DailyCostChart({ month, daily }: { month: string; daily: { day: string; costUsd: string }[] }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [active, setActive] = useState<number | null>(null);
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const byDay = new Map(daily.map((d) => [d.day, Number(d.costUsd)]));
  const days = Array.from({ length: daysInMonth }, (_, i) => {
    const day = `${month}-${String(i + 1).padStart(2, '0')}`;
    return { day, n: i + 1, cost: byDay.get(day) ?? 0 };
  });
  const max = Math.max(...days.map((d) => d.cost), 0);
  const ticks = new Set([1, 8, 15, 22, daysInMonth]);

  return (
    <section className="rounded-lg border bg-card p-4" aria-labelledby="daily-cost-title">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="daily-cost-title" className="text-sm font-medium">
          Daily cost (UTC)
        </h2>
        <Button variant="ghost" size="sm" onClick={() => setView(view === 'chart' ? 'table' : 'chart')}>
          {view === 'chart' ? 'Show as table' : 'Show as chart'}
        </Button>
      </div>

      {view === 'table' ? (
        <Table>
          <THead>
            <TR>
              <TH>Day</TH>
              <TH className="text-right">Cost</TH>
            </TR>
          </THead>
          <TBody>
            {days.filter((d) => d.cost > 0).map((d) => (
              <TR key={d.day}>
                <TD>{d.day}</TD>
                <TD className="text-right tabular-nums">{usd(d.cost)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : max === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No usage this month.</p>
      ) : (
        <div>
          <div className="mb-1 text-xs text-muted-foreground">{usd(max)}</div>
          <div className="relative flex h-32 items-end gap-[2px] border-b border-viz-baseline" onMouseLeave={() => setActive(null)}>
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 border-t border-viz-grid" />
            {days.map((d, i) => (
              <button
                key={d.day}
                type="button"
                aria-label={`${d.day}: ${usd(d.cost)}`}
                className="relative flex h-full min-w-0 flex-1 items-end justify-center focus:outline-none focus-visible:bg-muted"
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              >
                {d.cost > 0 && (
                  <span
                    className="block w-full max-w-6 rounded-t-[4px] bg-viz-accent"
                    style={{ height: `${Math.max((d.cost / max) * 100, 2)}%`, opacity: active === null || active === i ? 1 : 0.55 }}
                  />
                )}
                {active === i && (
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute bottom-full z-10 mb-2 whitespace-nowrap rounded-md border bg-card px-2 py-1 text-xs shadow-sm"
                    style={i > days.length * 0.75 ? { right: 0 } : i < days.length * 0.25 ? { left: 0 } : undefined}
                  >
                    <span className="text-muted-foreground">{d.day}</span> <span className="font-medium">{usd(d.cost)}</span>
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="mt-1 flex gap-[2px] text-[11px] text-muted-foreground" aria-hidden>
            {days.map((d) => (
              <span key={d.day} className="min-w-0 flex-1 text-center">
                {ticks.has(d.n) ? d.n : ''}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
