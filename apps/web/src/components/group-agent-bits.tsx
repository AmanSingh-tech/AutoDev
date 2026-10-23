import { cn } from '@autodev/ui';

export const KIND_LABEL: Record<string, string> = {
  vulnerable_dependency: 'Vulnerable dependency',
  outdated_dependency: 'Outdated dependency',
  failing_test: 'Failing test',
  flaky_test: 'Flaky test',
  repeated_failure: 'Across repositories',
  linked_repo_drift: 'Linked repo drift',
  unusual_spend: 'Unusual spend',
  stuck_task: 'Stuck task',
};

const SEVERITY: Record<string, { label: string; icon: string; className: string }> = {
  critical: { label: 'Critical', icon: '‼', className: 'border-status-critical/50 text-status-critical' },
  high: { label: 'High', icon: '!', className: 'border-status-critical/40 text-status-critical' },
  medium: { label: 'Medium', icon: '▲', className: 'border-status-warning/60 text-foreground' },
  low: { label: 'Low', icon: '•', className: 'text-muted-foreground' },
};

/** Severity always shows as an icon and a word, never color alone. */
export function SeverityBadge({ severity }: { severity: string }) {
  const s = SEVERITY[severity] ?? SEVERITY.low!;
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-medium', s.className)}>
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </span>
  );
}

const BAND = {
  good: 'border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  fair: 'border-amber-600/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  weak: 'border-red-600/40 bg-red-500/10 text-red-700 dark:text-red-400',
} as const;

/** A repo's health, 0–100, with the same bands as the prompt score (80+ good, 50+ fair). */
export function HealthBadge({ score, className }: { score: number; className?: string }) {
  const band = score >= 80 ? 'good' : score >= 50 ? 'fair' : 'weak';
  return (
    <span className={cn('inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium tabular-nums', BAND[band], className)} title={`Health ${score} of 100`}>
      {score}
    </span>
  );
}
