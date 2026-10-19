import { describe, expect, it } from 'vitest';
import { isAfter, STREAM_ID } from './bus';

describe('stream ids', () => {
  it('orders by time, then by sequence', () => {
    expect(isAfter('1700000000001-0', '1700000000000-5')).toBe(true);
    expect(isAfter('1700000000000-6', '1700000000000-5')).toBe(true);
    expect(isAfter('1700000000000-5', '1700000000000-5')).toBe(false);
    expect(isAfter('1699999999999-9', '1700000000000-0')).toBe(false);
  });

  it('accepts only real stream ids from clients', () => {
    expect(STREAM_ID.test('1700000000000-0')).toBe(true);
    expect(STREAM_ID.test('$')).toBe(false);
    expect(STREAM_ID.test('1700000000000-0 OR 1')).toBe(false);
  });
});
