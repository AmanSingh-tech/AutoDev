import type { TaskStatus } from '@autodev/db/schema';
import { cn } from '@autodev/ui';
import { Check, Hand } from 'lucide-react';

type Mode = 'plan_lld' | 'plan_only' | 'direct';
type Step = 'plan' | 'design' | 'code' | 'tests' | 'pr';

const LABEL: Record<Step, string> = { plan: 'Plan', design: 'Design', code: 'Code', tests: 'Tests', pr: 'Pull request' };
const STEPS: Record<Mode, Step[]> = {
  plan_lld: ['plan', 'design', 'code', 'tests', 'pr'],
  plan_only: ['plan', 'code', 'tests', 'pr'],
  direct: ['code', 'tests', 'pr'],
};

/** Which step a status belongs to, and whether it's waiting on a person. Null: not started, or ended. */
function position(status: TaskStatus): { step: Step | 'done' | null; waiting: boolean } {
  switch (status) {
    case 'planning':
      return { step: 'plan', waiting: false };
    case 'awaiting_plan_approval':
      return { step: 'plan', waiting: true };
    case 'designing':
      return { step: 'design', waiting: false };
    case 'awaiting_lld_approval':
      return { step: 'design', waiting: true };
    case 'coding':
    case 'waiting_for_builder':
      return { step: 'code', waiting: false };
    case 'needs_input':
      return { step: 'code', waiting: true };
    case 'testing':
    case 'fixing':
      return { step: 'tests', waiting: false };
    case 'pushed':
    case 'pr_open':
      return { step: 'pr', waiting: false };
    case 'resolved':
      return { step: 'done', waiting: false };
    default:
      return { step: null, waiting: false };
  }
}

/** Plan → Design → Code → Tests → Pull request, with the current step highlighted. */
export function TaskSteps({ mode, status }: { mode: Mode; status: TaskStatus }) {
  const steps = STEPS[mode];
  const { step, waiting } = position(status);
  const current = step === 'done' ? steps.length : step ? steps.indexOf(step) : -1;
  const ended = status === 'failed' || status === 'rejected' || status === 'cancelled';

  return (
    <ol aria-label="Progress" className="flex items-center gap-1 overflow-x-auto rounded-xl border bg-card p-1.5 shadow-card no-scrollbar">
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current && !ended;
        return (
          <li key={s} className="flex min-w-0 flex-1 items-center gap-1" aria-current={active ? 'step' : undefined}>
            <div
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors',
                active && (waiting ? 'bg-warning/10 font-medium text-foreground' : 'bg-accent font-medium text-accent-foreground'),
                done && 'text-foreground',
                !active && !done && 'text-muted-foreground',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold tabular-nums',
                  done && 'border-transparent bg-primary text-primary-foreground',
                  active && !waiting && 'border-primary text-primary',
                  active && waiting && 'border-transparent bg-warning text-white',
                )}
              >
                {done ? <Check className="size-3" strokeWidth={3} /> : active && waiting ? <Hand className="size-3" /> : i + 1}
              </span>
              <span className="truncate">{LABEL[s]}</span>
              <span className="sr-only">{done ? ' (done)' : active ? (waiting ? ' (waiting for you)' : ' (in progress)') : ''}</span>
              {active && !waiting && (
                <span aria-hidden className="relative ml-auto hidden size-1.5 shrink-0 sm:flex">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:animate-none" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
                </span>
              )}
            </div>
            {i < steps.length - 1 && <span aria-hidden className={cn('h-px w-3 shrink-0', i < current ? 'bg-primary' : 'bg-border')} />}
          </li>
        );
      })}
    </ol>
  );
}
