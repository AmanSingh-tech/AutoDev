import { cn } from '../cn';

export function Avatar({ src, alt, className }: { src?: string | null; alt: string; className?: string }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} className={cn('h-7 w-7 rounded-full bg-muted', className)} />
  ) : (
    <span
      aria-label={alt}
      className={cn('inline-flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-medium', className)}
    >
      {alt.slice(0, 1).toUpperCase()}
    </span>
  );
}
