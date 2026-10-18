import { STATUS_LABEL } from '@autodev/db/task-machine';
import type { TaskPriority, TaskStatus } from '@autodev/db/schema';
import { Badge, cn } from '@autodev/ui';

/** Status always reads as text. The icon only adds emphasis for states that need a person. */
const NEEDS_YOU: TaskStatus[] = ['awaiting_plan_approval', 'awaiting_lld_approval', 'needs_input', 'blocked_on_key'];

export function StatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  const variant = status === 'failed' || status === 'blocked_on_key' ? 'destructive' : status === 'draft' ? 'outline' : 'secondary';
  return (
    <Badge variant={variant} className={cn('whitespace-nowrap', className)} title={STATUS_LABEL[status]}>
      {NEEDS_YOU.includes(status) && <span aria-hidden className="mr-1">●</span>}
      <span className="truncate">{STATUS_LABEL[status]}</span>
    </Badge>
  );
}

const PRIORITY: Record<TaskPriority, { label: string; mark: string }> = {
  urgent: { label: 'Urgent', mark: '⏫' },
  high: { label: 'High', mark: '↑' },
  medium: { label: 'Medium', mark: '–' },
  low: { label: 'Low', mark: '↓' },
};

export function PriorityLabel({ priority, className }: { priority: TaskPriority; className?: string }) {
  const p = PRIORITY[priority];
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs text-muted-foreground', priority === 'urgent' && 'font-medium text-foreground', className)}>
      <span aria-hidden>{p.mark}</span>
      {p.label}
    </span>
  );
}

export const MODE_LABEL = { plan_lld: 'Plan → design → code', plan_only: 'Plan → code', direct: 'Direct' } as const;
