import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { relativeTime, formatElapsed, relativeFuture, daysUntilPurge } from './time.js';

describe('relativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for recent timestamps', () => {
    expect(relativeTime('2026-04-18T11:59:55Z')).toBe('just now');
  });

  it('returns Xs ago for seconds', () => {
    expect(relativeTime('2026-04-18T11:59:30Z')).toBe('30s ago');
  });

  it('returns Xm ago for minutes', () => {
    expect(relativeTime('2026-04-18T11:55:00Z')).toBe('5m ago');
  });

  it('returns Xh ago for hours', () => {
    expect(relativeTime('2026-04-18T09:00:00Z')).toBe('3h ago');
  });

  it('handles SQLite datetime (no T/Z) by treating it as UTC', () => {
    expect(relativeTime('2026-04-18 11:55:00')).toBe('5m ago');
  });

  it('returns empty string for falsy input', () => {
    expect(relativeTime(null)).toBe('');
    expect(relativeTime('')).toBe('');
  });
});

describe('formatElapsed', () => {
  it('formats seconds under a minute as Xs', () => {
    expect(formatElapsed(30)).toBe('30s');
  });

  it('formats minutes + seconds as "Xm Ys"', () => {
    expect(formatElapsed(125)).toBe('2m 5s');
  });

  it('handles exact minutes', () => {
    expect(formatElapsed(180)).toBe('3m 0s');
  });
});

describe('relativeFuture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty for falsy input', () => {
    expect(relativeFuture(null)).toEqual({ label: '', overdue: false });
    expect(relativeFuture('')).toEqual({ label: '', overdue: false });
    expect(relativeFuture(undefined)).toEqual({ label: '', overdue: false });
  });

  it('labels upcoming minutes as "in Xm"', () => {
    const result = relativeFuture('2026-04-18T12:05:00Z');
    expect(result).toEqual({ label: 'in 5m', overdue: false });
  });

  it('marks past dates as overdue', () => {
    const result = relativeFuture('2026-04-18T11:55:00Z');
    expect(result).toEqual({ label: 'overdue 5m', overdue: true });
  });

  it('uses hour magnitude for longer distances', () => {
    const result = relativeFuture('2026-04-18T15:00:00Z');
    expect(result).toEqual({ label: 'in 3h', overdue: false });
  });

  it('uses day magnitude for distances over 24h', () => {
    const result = relativeFuture('2026-04-20T12:00:00Z');
    expect(result).toEqual({ label: 'in 2d', overdue: false });
  });

  it('uses second magnitude for near-now dates', () => {
    const result = relativeFuture('2026-04-18T12:00:30Z');
    expect(result).toEqual({ label: 'in 30s', overdue: false });
  });

  it('gracefully handles invalid date strings', () => {
    expect(relativeFuture('not-a-date')).toEqual({ label: '', overdue: false });
  });

  it('handles SQLite datetime (no timezone) as UTC', () => {
    const result = relativeFuture('2026-04-18 12:05:00');
    expect(result).toEqual({ label: 'in 5m', overdue: false });
  });
});

describe('daysUntilPurge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for falsy / unparseable input', () => {
    expect(daysUntilPurge(null)).toBeNull();
    expect(daysUntilPurge('')).toBeNull();
    expect(daysUntilPurge('not-a-date')).toBeNull();
  });

  it('returns 7d when just deleted (default retention)', () => {
    const r = daysUntilPurge('2026-04-18T12:00:00Z');
    expect(r.daysLeft).toBe(7);
    expect(r.label).toBe('purges in 7d');
  });

  it('counts down with age', () => {
    const r = daysUntilPurge('2026-04-15T12:00:00Z'); // 3 days old → 4 left
    expect(r.daysLeft).toBe(4);
    expect(r.label).toBe('purges in 4d');
  });

  it('switches to hour granularity when <1d remains', () => {
    // 2026-04-18T12:00Z minus 2026-04-12T00:00Z = 6d12h → 12h left.
    const r = daysUntilPurge('2026-04-12T00:00:00Z');
    expect(r.daysLeft).toBe(1);
    expect(r.label).toBe('purges in 12h');
  });

  it('shows Nh precisely at the sub-day boundary', () => {
    // Clock 2026-04-18T12:00Z minus 6d22h → 2026-04-11T14:00Z. 2h left.
    const r = daysUntilPurge('2026-04-11T14:00:00Z');
    expect(r.label).toBe('purges in 2h');
  });

  it('uses "<1h" when well under an hour remains', () => {
    const deletedAt = new Date(
      new Date('2026-04-18T12:00:00Z').getTime() -
        (6 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000 + 59 * 60 * 1000 + 30 * 1000),
    ).toISOString();
    const r = daysUntilPurge(deletedAt);
    expect(r.label).toBe('purges in <1h');
  });

  it('clamps to 0 once the window has elapsed', () => {
    const r = daysUntilPurge('2026-04-01T12:00:00Z');
    expect(r.daysLeft).toBe(0);
    expect(r.label).toBe('purging…');
  });

  it('respects custom retentionDays', () => {
    const r = daysUntilPurge('2026-04-17T12:00:00Z', 14);
    expect(r.daysLeft).toBe(13);
  });

  it('handles SQLite datetime (no T) as UTC', () => {
    const r = daysUntilPurge('2026-04-15 12:00:00');
    expect(r.daysLeft).toBe(4);
  });
});
