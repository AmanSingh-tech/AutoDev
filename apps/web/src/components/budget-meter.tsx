import { cn } from '@autodev/ui';
import { usd } from '@/lib/format';

/**
 * Spent vs limit. The fill carries severity (accent, then warning at the soft limit, then critical
 * at the limit) and always comes with an icon and a text label, never color alone. A tick marks the soft limit.
 */
export function BudgetMeter({
  label,
  spentUsd,
  limitUsd,
  softPct,
  hardBlock,
}: {
  label: string;
  spentUsd: number;
  limitUsd: number;
  softPct: number;
  hardBlock: boolean;
}) {
  const pct = limitUsd > 0 ? (spentUsd / limitUsd) * 100 : 0;
  const state = pct >= 100 ? 'over' : pct >= softPct ? 'warn' : 'ok';
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          <span className="font-medium text-foreground">{usd(spentUsd)}</span> of {usd(limitUsd)} · {Math.round(pct)}%
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${label} budget`}
        aria-valuemin={0}
        aria-valuemax={limitUsd}
        aria-valuenow={Math.min(spentUsd, limitUsd)}
        aria-valuetext={`${usd(spentUsd)} of ${usd(limitUsd)}`}
        className="relative h-2 rounded-full bg-viz-track"
      >
        <div
          className={cn(
            'h-2 rounded-full',
            state === 'ok' && 'bg-viz-accent',
            state === 'warn' && 'bg-status-warning',
            state === 'over' && 'bg-status-critical',
          )}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
        <div
          aria-hidden
          title={`Warning at ${softPct}%`}
          className="absolute -top-1 h-4 w-0.5 rounded-full bg-foreground/60"
          style={{ left: `calc(${softPct}% - 1px)` }}
        />
      </div>
      {state !== 'ok' && (
        <p className="flex items-center gap-1.5 text-xs text-foreground">
          <span aria-hidden>{state === 'over' ? '⛔' : '⚠️'}</span>
          {state === 'over'
            ? hardBlock
              ? 'Limit reached: new agent runs are blocked until next month.'
              : 'Limit reached (not set to block runs).'
            : `Past the ${softPct}% warning threshold.`}
        </p>
      )}
    </div>
  );
}
