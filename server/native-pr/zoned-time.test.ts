import { describe, it, expect } from 'vitest';
import { zonedWallTimeToUtcMs, ZonedTimeError, isValidTimeZone } from './zoned-time.js';

const iso = (ms: number) => new Date(ms).toISOString();

describe('zonedWallTimeToUtcMs', () => {
  it('converts a standard-time wall clock to UTC', () => {
    expect(iso(zonedWallTimeToUtcMs('2026-12-01T09:30', 'America/Chicago'))).toBe(
      '2026-12-01T15:30:00.000Z',
    );
  });

  it('applies daylight time for summer dates', () => {
    expect(iso(zonedWallTimeToUtcMs('2026-07-01T09:30', 'America/Chicago'))).toBe(
      '2026-07-01T14:30:00.000Z',
    );
  });

  it('handles zones east of UTC and half-hour offsets', () => {
    expect(iso(zonedWallTimeToUtcMs('2026-10-13T00:15', 'Asia/Kolkata'))).toBe(
      '2026-10-12T18:45:00.000Z',
    );
  });

  it('treats UTC as identity', () => {
    expect(iso(zonedWallTimeToUtcMs('2026-10-13T08:00', 'UTC'))).toBe('2026-10-13T08:00:00.000Z');
  });

  it('resolves a spring-forward gap time to just after the gap', () => {
    // 2026-03-08 02:30 does not exist in Chicago; it becomes 03:30 CDT.
    expect(iso(zonedWallTimeToUtcMs('2026-03-08T02:30', 'America/Chicago'))).toBe(
      '2026-03-08T08:30:00.000Z',
    );
  });

  it('resolves an ambiguous fall-back time to its first occurrence', () => {
    // 2026-11-01 01:30 happens twice in Chicago; the first is CDT (-05:00).
    expect(iso(zonedWallTimeToUtcMs('2026-11-01T01:30', 'America/Chicago'))).toBe(
      '2026-11-01T06:30:00.000Z',
    );
  });

  it('rejects malformed input and unknown zones', () => {
    expect(() => zonedWallTimeToUtcMs('tomorrow 9am', 'UTC')).toThrow(ZonedTimeError);
    expect(() => zonedWallTimeToUtcMs('2026-02-30T09:00', 'UTC')).toThrow(ZonedTimeError);
    expect(() => zonedWallTimeToUtcMs('2026-10-13T25:00', 'UTC')).toThrow(ZonedTimeError);
    expect(() => zonedWallTimeToUtcMs('2026-10-13T09:00', 'Mars/Olympus')).toThrow(ZonedTimeError);
    expect(isValidTimeZone('Europe/London')).toBe(true);
  });
});
