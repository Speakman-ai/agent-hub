import { describe, it, expect } from 'vitest';
import {
  MAX_EXTENDED_RETENTION_MONTHS,
  MIN_EXTENDED_RETENTION_MONTHS,
  DEFAULT_EXTENDED_RETENTION_MONTHS,
  clampExtendedRetentionMonths,
  addMonthsUtc,
  computeRetainedUntil,
  toSqliteUtc,
} from './replay-retention.js';

describe('clampExtendedRetentionMonths', () => {
  it('clamps to the [1, 15] month window', () => {
    expect(clampExtendedRetentionMonths(0)).toBe(MIN_EXTENDED_RETENTION_MONTHS);
    expect(clampExtendedRetentionMonths(1)).toBe(1);
    expect(clampExtendedRetentionMonths(6)).toBe(6);
    expect(clampExtendedRetentionMonths(15)).toBe(15);
    expect(clampExtendedRetentionMonths(99)).toBe(MAX_EXTENDED_RETENTION_MONTHS);
    expect(clampExtendedRetentionMonths(-3)).toBe(MIN_EXTENDED_RETENTION_MONTHS);
  });

  it('floors fractional months', () => {
    expect(clampExtendedRetentionMonths(3.9)).toBe(3);
  });

  it('defaults unset / non-finite to the full 15 months', () => {
    expect(clampExtendedRetentionMonths(undefined)).toBe(DEFAULT_EXTENDED_RETENTION_MONTHS);
    expect(clampExtendedRetentionMonths(null)).toBe(DEFAULT_EXTENDED_RETENTION_MONTHS);
    expect(clampExtendedRetentionMonths(NaN)).toBe(DEFAULT_EXTENDED_RETENTION_MONTHS);
  });
});

describe('addMonthsUtc', () => {
  it('adds whole months in UTC', () => {
    const jan15 = Date.UTC(2026, 0, 15, 8, 30, 0);
    expect(addMonthsUtc(jan15, 1)).toBe(Date.UTC(2026, 1, 15, 8, 30, 0));
    expect(addMonthsUtc(jan15, 15)).toBe(Date.UTC(2027, 3, 15, 8, 30, 0));
  });

  it('rolls the year over correctly', () => {
    const nov1 = Date.UTC(2026, 10, 1, 0, 0, 0);
    expect(addMonthsUtc(nov1, 3)).toBe(Date.UTC(2027, 1, 1, 0, 0, 0));
  });

  it('clamps a day-of-month overflow to the last day of the target month', () => {
    // Jan 31 + 1 month → Feb 28 (2026 is not a leap year).
    const jan31 = Date.UTC(2026, 0, 31, 12, 0, 0);
    expect(addMonthsUtc(jan31, 1)).toBe(Date.UTC(2026, 1, 28, 12, 0, 0));
    // Jan 31 2028 + 1 month → Feb 29 (leap year).
    const jan31Leap = Date.UTC(2028, 0, 31, 12, 0, 0);
    expect(addMonthsUtc(jan31Leap, 1)).toBe(Date.UTC(2028, 1, 29, 12, 0, 0));
  });
});

describe('computeRetainedUntil', () => {
  it('starts the clock at ENABLE time, not capture (15-month window)', () => {
    // Capture ingested months ago is irrelevant — flagging now keeps it 15
    // months from now.
    const enabledAt = Date.UTC(2026, 5, 10, 9, 0, 0);
    const retainedUntil = computeRetainedUntil(enabledAt, DEFAULT_EXTENDED_RETENTION_MONTHS);
    expect(retainedUntil).toBe(Date.UTC(2027, 8, 10, 9, 0, 0)); // Jun 2026 + 15 → Sep 2027
    // The window is measured from enable, so it is always in the future of it.
    expect(retainedUntil).toBeGreaterThan(enabledAt);
  });

  it('clamps the requested window to [1, 15] months', () => {
    const enabledAt = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(computeRetainedUntil(enabledAt, 100)).toBe(
      addMonthsUtc(enabledAt, MAX_EXTENDED_RETENTION_MONTHS),
    );
    expect(computeRetainedUntil(enabledAt, 0)).toBe(
      addMonthsUtc(enabledAt, MIN_EXTENDED_RETENTION_MONTHS),
    );
    // Unset → default 15.
    expect(computeRetainedUntil(enabledAt, undefined)).toBe(
      addMonthsUtc(enabledAt, DEFAULT_EXTENDED_RETENTION_MONTHS),
    );
  });

  it('formats to SQLite-UTC text via toSqliteUtc (what the flag route persists)', () => {
    // The route stores toSqliteUtc(computeRetainedUntil(...)); assert that
    // composition end-to-end so the persisted `retained_until` format is locked.
    const enabledAt = Date.UTC(2026, 5, 10, 9, 0, 0);
    expect(toSqliteUtc(computeRetainedUntil(enabledAt, 15))).toBe('2027-09-10 09:00:00');
  });
});
