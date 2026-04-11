import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { relativeTime, formatElapsed, relativeFuture } from './time.js';

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
    expect(result).not.toContain('ago');
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
    expect(result.label).toBe('in 5m');
    expect(result.overdue).toBe(false);
  });

  it('returns overdue time for past dates', () => {
    const result = relativeFuture('2025-06-15T11:55:00Z');
    expect(result.label).toBe('overdue 5m');
    expect(result.overdue).toBe(true);
  });

  it('handles hour magnitudes', () => {
    const result = relativeFuture('2025-06-15T15:00:00Z');
    expect(result.label).toBe('in 3h');
    expect(result.overdue).toBe(false);
  });

  it('handles day magnitudes', () => {
    const result = relativeFuture('2025-06-17T12:00:00Z');
    expect(result.label).toBe('in 2d');
    expect(result.overdue).toBe(false);
  });

  it('handles second magnitudes', () => {
    const result = relativeFuture('2025-06-15T12:00:30Z');
    expect(result.label).toBe('in 30s');
    expect(result.overdue).toBe(false);
  });
});
