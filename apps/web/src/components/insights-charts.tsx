'use client';

import { Button, Table, TBody, TD, TH, THead, TR } from '@autodev/ui';
import { useId, useState } from 'react';

/**
 * Charts for the insights page, following the same rules as DailyCostChart: one series per chart
 * (so the title names it and there's no legend), the validated `viz-accent` hue, 4px rounded bar
 * ends on a baseline, a 2px gap between bars, a hover/focus tooltip on every mark, and a table view
 * so no value needs hovering.
 */

export interface Point {
  label: string;
  value: number;
}

/** Bars over time buckets for one measure. */
export function TrendChart({ title, points, format, empty }: { title: string; points: Point[]; format: (v: number) => string; empty: string }) {
  const id = useId();
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(0, ...points.map((p) => p.value));
  // A tick at the start, the end and two in between keeps labels from colliding.
  const tickEvery = Math.max(1, Math.ceil(points.length / 4));

  return (
    <section className="rounded-lg border bg-card p-4" aria-labelledby={id}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id={id} className="text-sm font-medium">
          {title}
        </h2>
        <Button variant="ghost" size="sm" onClick={() => setView(view === 'chart' ? 'table' : 'chart')}>
          {view === 'chart' ? 'Show as table' : 'Show as chart'}
        </Button>
      </div>
      {view === 'table' ? (
        <Table>
          <THead>
            <TR>
              <TH>Period</TH>
              <TH className="text-right">{title}</TH>
            </TR>
          </THead>
          <TBody>
            {points.map((p) => (
              <TR key={p.label}>
                <TD>{p.label}</TD>
                <TD className="text-right tabular-nums">{format(p.value)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : max === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div>
          <div className="mb-1 text-xs tabular-nums text-muted-foreground">{format(max)}</div>
          <div className="relative flex h-32 items-end gap-[2px] border-b border-viz-baseline" onMouseLeave={() => setActive(null)}>
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 border-t border-viz-grid" />
            {points.map((p, i) => (
              <button
                key={p.label}
                type="button"
                aria-label={`${p.label}: ${format(p.value)}`}
                className="relative flex h-full min-w-0 flex-1 items-end justify-center focus:outline-none focus-visible:bg-muted"
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              >
                {p.value > 0 && (
                  <span
                    className="block w-full max-w-6 rounded-t-[4px] bg-viz-accent transition-opacity duration-150 ease-out"
                    style={{ height: `${Math.max((p.value / max) * 100, 2)}%`, opacity: active === null || active === i ? 1 : 0.55 }}
                  />
                )}
                {active === i && (
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute bottom-full z-10 mb-2 whitespace-nowrap rounded-md border bg-card px-2 py-1 text-xs shadow-sm"
                    style={i > points.length * 0.75 ? { right: 0 } : i < points.length * 0.25 ? { left: 0 } : undefined}
                  >
                    <span className="text-muted-foreground">{p.label}</span> <span className="font-medium tabular-nums">{format(p.value)}</span>
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="mt-1 flex gap-[2px] text-[11px] text-muted-foreground" aria-hidden>
            {points.map((p, i) => (
              <span key={p.label} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center">
                {i === 0 || i === points.length - 1 || i % tickEvery === 0 ? p.label.slice(5) : ''}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Magnitude by category (spend by model, by repo), as horizontal bars sorted largest first. Values
 * are printed in text ink beside each bar, so the bar only carries length.
 */
export function BarList({ title, rows, format, empty, limit = 8 }: { title: string; rows: Point[]; format: (v: number) => string; empty: string; limit?: number }) {
  const id = useId();
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const shown = sorted.slice(0, limit);
  const rest = sorted.slice(limit).reduce((s, r) => s + r.value, 0);
  const all = rest > 0 ? [...shown, { label: `${sorted.length - limit} more`, value: rest }] : shown;
  const max = Math.max(0, ...all.map((r) => r.value));
  return (
    <section className="rounded-lg border bg-card p-4" aria-labelledby={id}>
      <h2 id={id} className="mb-3 text-sm font-medium">
        {title}
      </h2>
      {max === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-2.5">
          {all.map((r) => (
            <li key={r.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm">
              <span className="truncate" title={r.label}>
                {r.label}
              </span>
              <span className="tabular-nums text-muted-foreground">{format(r.value)}</span>
              <span className="col-span-2 block h-2 rounded-[4px] bg-viz-track" aria-hidden>
                <span className="block h-2 rounded-[4px] bg-viz-accent" style={{ width: `${Math.max((r.value / max) * 100, 1)}%` }} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
