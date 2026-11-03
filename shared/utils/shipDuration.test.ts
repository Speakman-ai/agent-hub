import { describe, expect, it } from 'vitest';
import { formatShipDuration } from './shipDuration';

describe('formatShipDuration', () => {
  it('returns null for sessions that never shipped', () => {
    expect(formatShipDuration(null)).toBeNull();
    expect(formatShipDuration(undefined)).toBeNull();
    expect(formatShipDuration(-5)).toBeNull();
  });

  it('scales the unit to the duration', () => {
    expect(formatShipDuration(42)).toBe('42s');
    expect(formatShipDuration(5 * 60 + 10)).toBe('5m');
    expect(formatShipDuration(3600)).toBe('1h');
    expect(formatShipDuration(2 * 3600 + 15 * 60)).toBe('2h 15m');
    expect(formatShipDuration(26 * 3600)).toBe('1d 2h');
    expect(formatShipDuration(48 * 3600)).toBe('2d');
  });
});
