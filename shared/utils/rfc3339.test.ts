import { describe, expect, it } from 'vitest';
import { compareRfc3339, isRfc3339, nanosToRfc3339, rfc3339ToNanos, shiftRfc3339 } from './rfc3339';

describe('rfc3339', () => {
  it('keeps sub-millisecond precision that Date would drop', () => {
    const a = '2026-10-08T10:00:00.123500Z';
    const b = '2026-10-08T10:00:00.123900Z';
    expect(Date.parse(a)).toBe(Date.parse(b));
    expect(compareRfc3339(a, b)).toBe(-1);
    expect(rfc3339ToNanos(b)! - rfc3339ToNanos(a)!).toBe(400_000n);
  });

  it('shifts by exactly one nanosecond without rounding', () => {
    expect(shiftRfc3339('2026-10-08T10:00:00.123900Z', 1n)).toBe('2026-10-08T10:00:00.123900001Z');
    expect(shiftRfc3339('2026-10-08T10:00:00Z', -1n)).toBe('2026-10-08T09:59:59.999999999Z');
  });

  it('normalizes offsets to UTC', () => {
    expect(compareRfc3339('2026-10-08T12:00:00+02:00', '2026-10-08T10:00:00Z')).toBe(0);
    expect(nanosToRfc3339(rfc3339ToNanos('2026-10-08T12:00:00.5+02:00')!)).toBe(
      '2026-10-08T10:00:00.500000000Z',
    );
  });

  it('rejects non-RFC 3339 input and sorts it first', () => {
    expect(isRfc3339('yesterday')).toBe(false);
    expect(isRfc3339('2026-10-08T10:00:00')).toBe(false);
    expect(compareRfc3339(null, '2026-10-08T10:00:00Z')).toBe(-1);
    expect(compareRfc3339(null, undefined)).toBe(0);
  });
});
