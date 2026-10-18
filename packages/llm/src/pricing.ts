import type { UsageEntry } from './types';

export interface PriceRow {
  inputPerMtok: string;
  outputPerMtok: string;
  cacheWrite5mPerMtok: string;
  cacheWrite1hPerMtok: string;
  cacheReadPerMtok: string;
}

/** "4.000000" USD/MTok → micro-dollars per MTok, exactly (prices have at most 6 decimals). */
function micro(v: string): bigint {
  const [whole, frac = ''] = v.split('.');
  return BigInt(whole || '0') * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
}

/**
 * Exact cost in USD as a 6-decimal string. Computed in integer pico-dollars to avoid float drift,
 * then rounded half-up to micro-dollars.
 */
export function costUsd(u: UsageEntry, p: PriceRow): string {
  const pico =
    BigInt(u.inputTokens) * micro(p.inputPerMtok) +
    BigInt(u.outputTokens) * micro(p.outputPerMtok) +
    BigInt(u.cacheWrite5mTokens) * micro(p.cacheWrite5mPerMtok) +
    BigInt(u.cacheWrite1hTokens) * micro(p.cacheWrite1hPerMtok) +
    BigInt(u.cacheReadTokens) * micro(p.cacheReadPerMtok);
  const microUsd = (pico + 500_000n) / 1_000_000n;
  const s = microUsd.toString().padStart(7, '0');
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

/** Tokens that count toward the per-task cap. Cache reads are excluded: they're cheap and repeated. */
export const cappedTokens = (u: UsageEntry) => u.inputTokens + u.outputTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens;
