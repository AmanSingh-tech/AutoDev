import * as React from 'react';
import { cn } from '../cn';

/**
 * "Working on it" with three pulsing dots. The dots are decorative (aria-hidden); the label is what
 * screen readers hear. With reduced motion the dots hold still.
 */
export function Pending({ label, className }: { label: string; className?: string }) {
  return (
    <p role="status" className={cn('inline-flex items-center gap-2 text-sm text-muted-foreground', className)}>
      <span aria-hidden className="inline-flex gap-1">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-current motion-reduce:animate-none motion-reduce:opacity-60"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      {label}
    </p>
  );
}
