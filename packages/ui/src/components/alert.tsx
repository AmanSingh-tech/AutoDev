import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import * as React from 'react';
import { cn } from '../cn';

type Tone = 'default' | 'destructive' | 'warning' | 'success';

const TONE: Record<Tone, { box: string; icon: React.ComponentType<{ className?: string }> }> = {
  default: { box: 'border-border bg-secondary/60 text-foreground', icon: Info },
  destructive: { box: 'border-destructive/30 bg-destructive/10 text-destructive', icon: CircleAlert },
  warning: { box: 'border-warning/30 bg-warning/10 text-foreground', icon: TriangleAlert },
  success: { box: 'border-success/30 bg-success/10 text-foreground', icon: CircleCheck },
};

/** A tinted notice with its tone's icon. The text carries the meaning; the color only supports it. */
export const Alert = ({ className, tone = 'default', children, ...p }: React.HTMLAttributes<HTMLDivElement> & { tone?: Tone }) => {
  const t = TONE[tone];
  const Icon = t.icon;
  return (
    <div role="alert" className={cn('flex gap-2.5 rounded-lg border px-3.5 py-3 text-sm', t.box, className)} {...p}>
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', tone === 'warning' && 'text-warning', tone === 'success' && 'text-success', tone === 'default' && 'text-muted-foreground')} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
};
