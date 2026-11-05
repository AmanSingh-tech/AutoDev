import { cn } from '@autodev/ui';
import type { LucideIcon } from 'lucide-react';

/** label · value. The hero variant is the one number a view leads with (one per view). */
export function StatTile({ label, value, hero, hint, icon: Icon }: { label: string; value: string; hero?: boolean; hint?: string; icon?: LucideIcon }) {
  return (
    <div className={cn('rounded-xl border bg-card p-4 shadow-card', hero && 'sm:col-span-2')}>
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        {Icon && <Icon aria-hidden className="size-4" />}
        {label}
      </div>
      <div className={cn('mt-1 font-semibold tracking-tight', hero ? 'text-5xl' : 'text-2xl')}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
