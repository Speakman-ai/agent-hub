import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { relativeTime, formatElapsed, relativeFuture, daysUntilPurge, shortDate } from './time';

describe('formatElapsed', () => {
  it('formats seconds under a minute', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(30)).toBe('30s');
    expect(formatElapsed(59)).toBe('59s');
  });

  it('formats minutes and seconds', () => {
    expect(formatElapsed(60)).toBe('1m 0s');
    expect(formatElapsed(90)).toBe('1m 30s');
    expect(formatElapsed(125)).toBe('2m 5s');
    expect(formatElapsed(3661)).toBe('61m 1s');
  });
});

describe('shortDate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty string for falsy / unparseable input', () => {
    expect(shortDate(null)).toBe('');
    expect(shortDate(undefined)).toBe('');
    expect(shortDate('')).toBe('');
  });

  it('omits the year for dates in the current year', () => {
    const out = shortDate('2025-03-09T00:00:00Z');
    expect(out!).not.toMatch(/2025/);
    expect(out!).toMatch(/Mar/);
  });

  it('includes the year for dates in a different year', () => {
    expect(shortDate('2024-12-31T00:00:00Z')).toMatch(/2024/);
  });

  it('parses SQLite datetime (no T) as UTC', () => {
    expect(shortDate('2025-03-09 08:30:00')).toMatch(/Mar/);
  });
});

describe('relativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty string for falsy input', () => {
    expect(relativeTime(null)).toBe('');
    expect(relativeTime(undefined)).toBe('');
    expect(relativeTime('')).toBe('');
  });

  it('returns "just now" for very recent dates', () => {
    expect(relativeTime('2025-06-15T12:00:00Z')).toBe('just now');
    expect(relativeTime('2025-06-15T11:59:55Z')).toBe('just now');
  });

  it('returns seconds ago', () => {
    expect(relativeTime('2025-06-15T11:59:30Z')).toBe('30s ago');
  });

  it('returns minutes ago', () => {
    expect(relativeTime('2025-06-15T11:55:00Z')).toBe('5m ago');
    expect(relativeTime('2025-06-15T11:01:00Z')).toBe('59m ago');
  });

  it('returns hours ago', () => {
    expect(relativeTime('2025-06-15T10:00:00Z')).toBe('2h ago');
    expect(relativeTime('2025-06-14T13:00:00Z')).toBe('23h ago');
  });

  it('returns days ago', () => {
    expect(relativeTime('2025-06-14T12:00:00Z')).toBe('1d ago');
    expect(relativeTime('2025-06-10T12:00:00Z')).toBe('5d ago');
  });

  it('returns formatted date for older dates', () => {
    const result = relativeTime('2025-06-01T12:00:00Z');
    // Beyond 7 days, returns toLocaleDateString() — just verify it's not a relative format
    expect(result!).not.toContain('ago');
  });

  it('handles SQLite datetime format (no T)', () => {
    // SQLite dates like "2025-06-15 11:55:00" have no T — treated as UTC
    expect(relativeTime('2025-06-15 11:55:00')).toBe('5m ago');
  });
});

describe('relativeFuture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty for falsy input', () => {
    expect(relativeFuture(null)).toEqual({ label: '', overdue: false });
    expect(relativeFuture('')).toEqual({ label: '', overdue: false });
  });

  it('returns future time with "in" prefix', () => {
    const result = relativeFuture('2025-06-15T12:05:00Z');
    expect(result!.label).toBe('in 5m');
    expect(result!.overdue).toBe(false);
  });

  it('returns overdue time for past dates', () => {
    const result = relativeFuture('2025-06-15T11:55:00Z');
    expect(result!.label).toBe('overdue 5m');
    expect(result!.overdue).toBe(true);
  });

  it('handles hour magnitudes', () => {
    const result = relativeFuture('2025-06-15T15:00:00Z');
    expect(result!.label).toBe('in 3h');
    expect(result!.overdue).toBe(false);
  });

  it('handles day magnitudes', () => {
    const result = relativeFuture('2025-06-17T12:00:00Z');
    expect(result!.label).toBe('in 2d');
    expect(result!.overdue).toBe(false);
  });

  it('handles second magnitudes', () => {
    const result = relativeFuture('2025-06-15T12:00:30Z');
    expect(result!.label).toBe('in 30s');
    expect(result!.overdue).toBe(false);
  });
});

describe('daysUntilPurge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for missing / unparseable timestamps', () => {
    expect(daysUntilPurge(null)).toBeNull();
    expect(daysUntilPurge('')).toBeNull();
    expect(daysUntilPurge('not-a-date')).toBeNull();
  });

  it('returns 7d label when just deleted', () => {
    const r = daysUntilPurge('2025-06-15T12:00:00Z');
    expect(r!.daysLeft).toBe(7);
    expect(r!.label).toBe('purges in 7d');
  });

  it('counts down as time passes', () => {
    // Deleted ~3 days ago → 4 days left.
    const r = daysUntilPurge('2025-06-12T12:00:00Z');
    expect(r!.daysLeft).toBe(4);
    expect(r!.label).toBe('purges in 4d');
  });

  it('switches to hour granularity when <1d remains', () => {
    // Deleted ~6.5 days ago → 12h left (0.5d remaining, well under a day).
    const r = daysUntilPurge('2025-06-09T00:00:00Z');
    expect(r!.daysLeft).toBe(1);
    expect(r!.label).toBe('purges in 12h');
  });

  it('uses "<1h" when well under an hour remains', () => {
    // 6d 23h 59m 30s old → 30s left → "<1h".
    const deletedAt = new Date(
      new Date('2025-06-15T12:00:00Z').getTime() -
        (6 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000 + 59 * 60 * 1000 + 30 * 1000),
    ).toISOString();
    const r = daysUntilPurge(deletedAt);
    expect(r!.daysLeft).toBe(1);
    expect(r!.label).toBe('purges in <1h');
  });

  it('shows Nh precisely at the sub-day boundary', () => {
    // Clock 2025-06-15T12:00Z minus (6d22h) → 2025-06-08T14:00Z. 2h left.
    const r = daysUntilPurge('2025-06-08T14:00:00Z');
    expect(r!.label).toBe('purges in 2h');
  });

  it('clamps to 0 once the retention window has elapsed', () => {
    const r = daysUntilPurge('2025-06-01T12:00:00Z');
    expect(r!.daysLeft).toBe(0);
    expect(r!.label).toBe('purging…');
  });

  it('respects custom retention windows', () => {
    const r = daysUntilPurge('2025-06-14T12:00:00Z', 14);
    expect(r!.daysLeft).toBe(13);
    expect(r!.label).toBe('purges in 13d');
  });

  it('handles SQLite-style datetime (no T, no TZ → treated as UTC)', () => {
    const r = daysUntilPurge('2025-06-12 12:00:00');
    expect(r!.daysLeft).toBe(4);
  });
});
