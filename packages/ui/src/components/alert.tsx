import * as React from 'react';
import { cn } from '../cn';

export const Alert = ({
  className,
  tone = 'default',
  ...p
}: React.HTMLAttributes<HTMLDivElement> & { tone?: 'default' | 'destructive' }) => (
  <div
    role="alert"
    className={cn(
      'rounded-lg border px-4 py-3 text-sm',
      tone === 'destructive' && 'border-destructive/50 text-destructive',
      className,
    )}
    {...p}
  />
);
