import * as React from 'react';
import { cn } from '../cn';

/**
 * A table in its own framed card with a tinted header row. `framed={false}` for a table that's
 * already inside a Card. Wide tables scroll sideways inside the frame, never the page.
 */
export const Table = ({ className, framed = true, ...p }: React.TableHTMLAttributes<HTMLTableElement> & { framed?: boolean }) => (
  <div className={cn('relative w-full overflow-x-auto', framed && 'rounded-xl border bg-card shadow-card')}>
    <table className={cn('w-full caption-bottom text-sm', className)} {...p} />
  </div>
);
export const THead = (p: React.HTMLAttributes<HTMLTableSectionElement>) => <thead className="bg-secondary/50 [&_tr]:border-b [&_tr]:hover:bg-transparent" {...p} />;
export const TBody = (p: React.HTMLAttributes<HTMLTableSectionElement>) => <tbody className="[&_tr:last-child]:border-0" {...p} />;
export const TR = ({ className, ...p }: React.HTMLAttributes<HTMLTableRowElement>) => <tr className={cn('border-b transition-colors hover:bg-secondary/40', className)} {...p} />;
export const TH = ({ className, ...p }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
  <th className={cn('h-10 whitespace-nowrap px-4 text-left align-middle text-xs font-medium uppercase tracking-wide text-muted-foreground', className)} {...p} />
);
export const TD = ({ className, ...p }: React.TdHTMLAttributes<HTMLTableCellElement>) => <td className={cn('px-4 py-3 align-middle', className)} {...p} />;
