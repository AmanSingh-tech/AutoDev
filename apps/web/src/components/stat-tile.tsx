import { cn } from '@autodev/ui';

/** label · value. The hero variant is the one number a view leads with (one per view). */
export function StatTile({ label, value, hero, hint }: { label: string; value: string; hero?: boolean; hint?: string }) {
  return (
    <div className={cn('rounded-lg border bg-card p-4', hero && 'sm:col-span-2')}>
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className={cn('mt-1 font-semibold tracking-tight', hero ? 'text-5xl' : 'text-2xl')}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
