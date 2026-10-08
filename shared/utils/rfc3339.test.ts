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

  it('rejects impossible calendar values that Date.parse would roll forward', () => {
    for (const ts of [
      '2026-02-30T00:00:00Z',
      '2026-02-29T00:00:00Z',
      '2100-02-29T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '2026-13-08T10:00:00Z',
      '2026-00-08T10:00:00Z',
      '2026-10-00T10:00:00Z',
      '2026-10-08T24:00:00Z',
      '2026-10-08T23:60:00Z',
      '2026-10-08T23:59:60Z',
      '2026-10-08T10:00:00+24:00',
      '2026-10-08T10:00:00-23:60',
    ]) {
      expect(rfc3339ToNanos(ts), ts).toBeNull();
      expect(isRfc3339(ts), ts).toBe(false);
    }
    expect(rfc3339ToNanos('2024-02-29T00:00:00Z')).not.toBeNull();
    expect(rfc3339ToNanos('2000-02-29T00:00:00Z')).not.toBeNull();
  });

  it('matches Date for valid timestamps across years, months, and offsets', () => {
    const offsets = ['Z', '+00:00', '+05:30', '-08:00', '+23:59', '-23:59'];
    for (const year of [1, 1600, 1899, 1969, 1970, 2000, 2024, 2026, 2100, 9999]) {
      for (let month = 1; month <= 12; month++) {
        for (const day of [1, 15, 28]) {
          const offset = offsets[(year + month + day) % offsets.length];
          const ts = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T13:47:09${offset}`;
          expect(rfc3339ToNanos(ts), ts).toBe(BigInt(Date.parse(ts)) * 1_000_000n);
        }
      }
    }
  });
});
