import Link from 'next/link';
import type { ReactNode } from 'react';
import { AutoDevMark } from './shell/sidebar';

/** Sign-in and the organization picker: the mark, a soft glow, and one centered card. */
export function AuthLayout({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-4 py-12">
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-[-12rem] h-[28rem] w-[48rem] -translate-x-1/2 rounded-full bg-primary/15 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(var(--foreground)/0.06)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]" />
      <Link href="/" className="relative mb-8 flex items-center gap-2 text-lg font-semibold">
        <AutoDevMark className="size-7" />
        AutoDev
      </Link>
      <div className="relative w-full max-w-md">{children}</div>
      {footer && <div className="relative mt-6 text-sm text-muted-foreground">{footer}</div>}
    </main>
  );
}
