const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat('en-US');

/** $0.42, $12.40, $4.2K. Below a cent, shows enough digits to not read as zero. */
export function usd(v: number | string, opts: { compact?: boolean } = {}): string {
  const n = Number(v);
  if (opts.compact && Math.abs(n) >= 10_000) return `$${compact.format(n)}`;
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const tokens = (v: number) => (Math.abs(v) >= 10_000 ? compact.format(v) : exact.format(v));
export const int = (v: number) => exact.format(v);

export function relativeTime(d: Date | string | null): string {
  if (!d) return 'never';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}
