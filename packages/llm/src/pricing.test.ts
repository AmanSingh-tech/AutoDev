import { describe, expect, it } from 'vitest';
import { cappedTokens, costUsd } from './pricing';

const opus = {
  inputPerMtok: '4.000000',
  outputPerMtok: '20.000000',
  cacheWrite5mPerMtok: '5.000000',
  cacheWrite1hPerMtok: '8.000000',
  cacheReadPerMtok: '0.200000',
};
const zero = { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, model: 'm' };

describe('costUsd', () => {
  it('prices each token class exactly', () => {
    expect(costUsd({ ...zero, inputTokens: 1_000_000 }, opus)).toBe('4.000000');
    expect(costUsd({ ...zero, outputTokens: 1234 }, opus)).toBe('0.024680');
    expect(costUsd({ ...zero, cacheWrite5mTokens: 1000, cacheWrite1hTokens: 1000, cacheReadTokens: 10_000 }, opus)).toBe('0.015000');
  });

  it('rounds sub-micro-dollar amounts half-up', () => {
    // 1 cache-read token at $0.20/MTok = $0.0000002 rounds to 0; 3 tokens = 0.0000006 → 0.000001
    expect(costUsd({ ...zero, cacheReadTokens: 1 }, opus)).toBe('0.000000');
    expect(costUsd({ ...zero, cacheReadTokens: 3 }, opus)).toBe('0.000001');
  });

  it('handles fractional per-MTok prices such as 0.125', () => {
    const haiku = { ...opus, cacheWrite5mPerMtok: '0.125' };
    expect(costUsd({ ...zero, cacheWrite5mTokens: 8_000_000 }, haiku)).toBe('1.000000');
  });
});

describe('cappedTokens', () => {
  it('counts input, output and cache writes but not cache reads', () => {
    expect(cappedTokens({ ...zero, inputTokens: 1, outputTokens: 2, cacheWrite5mTokens: 3, cacheWrite1hTokens: 4, cacheReadTokens: 1000 })).toBe(10);
  });
});
