/**
 * Unit tests for `computeDayWindow` — the calendar day-boundary math behind the
 * dashboard's "today's events" read. Locks the timezone-aware bucketing so
 * events near a user's local midnight land on the right day (reviewer note:
 * UTC-day default vs. an explicit `tz`).
 */
import { describe, it, expect } from 'vitest';
import { computeDayWindow } from './me-dashboard-google.js';

describe('computeDayWindow', () => {
  it('defaults to the UTC calendar day of `now`', () => {
    const now = new Date('2026-07-07T15:30:00Z');
    const w = computeDayWindow({ now });
    expect(w).toEqual({
      date: '2026-07-07',
      timeMin: '2026-07-07T00:00:00.000Z',
      timeMax: '2026-07-08T00:00:00.000Z',
    });
  });

  it('honours an explicit UTC `date` override', () => {
    const w = computeDayWindow({ now: new Date('2026-07-07T15:30:00Z'), date: '2026-12-25' });
    expect(w.date).toBe('2026-12-25');
    expect(w.timeMin).toBe('2026-12-25T00:00:00.000Z');
    expect(w.timeMax).toBe('2026-12-26T00:00:00.000Z');
  });

  it('brackets the local day for a west-of-UTC zone (America/New_York, DST)', () => {
    // 2026-07-07 is EDT (UTC-4): local midnight = 04:00Z, next local midnight = 04:00Z+1d.
    const w = computeDayWindow({
      now: new Date('2026-07-07T12:00:00Z'),
      timeZone: 'America/New_York',
    });
    expect(w.date).toBe('2026-07-07');
    expect(w.timeMin).toBe('2026-07-07T04:00:00.000Z');
    expect(w.timeMax).toBe('2026-07-08T04:00:00.000Z');
  });

  it('resolves "today" in the target zone, not UTC, near the date line', () => {
    // 2026-07-07T22:00Z is already 2026-07-08 07:00 in Tokyo (UTC+9).
    const w = computeDayWindow({ now: new Date('2026-07-07T22:00:00Z'), timeZone: 'Asia/Tokyo' });
    expect(w.date).toBe('2026-07-08');
    // Tokyo local midnight of 07-08 = 2026-07-07T15:00Z.
    expect(w.timeMin).toBe('2026-07-07T15:00:00.000Z');
    expect(w.timeMax).toBe('2026-07-08T15:00:00.000Z');
  });

  it('spans 23h across a spring-forward DST transition', () => {
    // America/New_York springs forward 2026-03-08 (EST→EDT): the local day is 23h.
    const w = computeDayWindow({
      now: new Date('2026-03-08T12:00:00Z'),
      timeZone: 'America/New_York',
    });
    expect(w.timeMin).toBe('2026-03-08T05:00:00.000Z'); // EST midnight
    expect(w.timeMax).toBe('2026-03-09T04:00:00.000Z'); // EDT midnight
    const hours = (Date.parse(w.timeMax) - Date.parse(w.timeMin)) / 3_600_000;
    expect(hours).toBe(23);
  });

  it('falls back to the UTC day when the zone is unrecognised', () => {
    const now = new Date('2026-07-07T15:30:00Z');
    const w = computeDayWindow({ now, timeZone: 'Not/AZone' });
    expect(w).toEqual({
      date: '2026-07-07',
      timeMin: '2026-07-07T00:00:00.000Z',
      timeMax: '2026-07-08T00:00:00.000Z',
    });
  });
});
