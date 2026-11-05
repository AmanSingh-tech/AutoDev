import { cn } from '@autodev/ui';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** The title row every page starts with: title, one line of context, and the page's main actions. */
export function PageHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3', className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** What an empty list says instead: what goes here, and the one thing to do next. */
export function EmptyState({ icon: Icon, title, children, action, className }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center rounded-xl border border-dashed bg-card/50 px-6 py-12 text-center', className)}>
      <span className="mb-4 flex size-11 items-center justify-center rounded-xl bg-accent text-accent-foreground">
        <Icon aria-hidden className="size-5" />
      </span>
      <h3 className="font-medium">{title}</h3>
      {children && <div className="mt-1.5 max-w-sm text-sm text-muted-foreground">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
