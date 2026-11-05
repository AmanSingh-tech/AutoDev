import { STATUS_LABEL } from '@autodev/db/task-machine';
import type { TaskPriority, TaskStatus } from '@autodev/db/schema';
import { Badge, cn } from '@autodev/ui';
import { ArrowDown, ArrowUp, ChevronsUp, CircleAlert, CircleCheck, CircleDashed, CircleSlash, GitPullRequest, Hand, Minus, type LucideIcon } from 'lucide-react';

/** Status always reads as text; the color and icon group it by phase (needs you, working, review, done). */
const NEEDS_YOU: TaskStatus[] = ['awaiting_plan_approval', 'awaiting_lld_approval', 'needs_input'];
const WORKING: TaskStatus[] = ['queued', 'planning', 'designing', 'coding', 'waiting_for_builder', 'testing', 'fixing'];

type Tone = { variant: 'destructive' | 'outline' | 'secondary' | 'accent' | 'success' | 'warning' | 'info'; icon: LucideIcon | null; pulse?: boolean };
function toneFor(status: TaskStatus): Tone {
  if (status === 'failed' || status === 'blocked_on_key') return { variant: 'destructive', icon: CircleAlert };
  if (NEEDS_YOU.includes(status)) return { variant: 'warning', icon: Hand };
  if (WORKING.includes(status)) return { variant: 'accent', icon: null, pulse: true };
  if (status === 'pr_open' || status === 'pushed') return { variant: 'info', icon: GitPullRequest };
  if (status === 'resolved') return { variant: 'success', icon: CircleCheck };
  if (status === 'draft') return { variant: 'outline', icon: CircleDashed };
  return { variant: 'outline', icon: CircleSlash };
}

export function StatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  const t = toneFor(status);
  return (
    <Badge variant={t.variant} className={cn('max-w-full', className)} title={STATUS_LABEL[status]}>
      {t.pulse ? (
        <span aria-hidden className="relative flex size-1.5 shrink-0">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
      ) : (
        t.icon && <t.icon aria-hidden className="shrink-0" />
      )}
      <span className="truncate">{STATUS_LABEL[status]}</span>
    </Badge>
  );
}

const PRIORITY: Record<TaskPriority, { label: string; icon: LucideIcon; tone: string }> = {
  urgent: { label: 'Urgent', icon: ChevronsUp, tone: 'text-destructive' },
  high: { label: 'High', icon: ArrowUp, tone: 'text-warning' },
  medium: { label: 'Medium', icon: Minus, tone: 'text-muted-foreground' },
  low: { label: 'Low', icon: ArrowDown, tone: 'text-muted-foreground' },
};

export function PriorityLabel({ priority, className }: { priority: TaskPriority; className?: string }) {
  const p = PRIORITY[priority];
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs text-muted-foreground', priority === 'urgent' && 'font-medium text-foreground', className)}>
      <p.icon aria-hidden className={cn('size-3.5', p.tone)} />
      {p.label}
    </span>
  );
}

export const MODE_LABEL = { plan_lld: 'Plan → design → code', plan_only: 'Plan → code', direct: 'Direct' } as const;
