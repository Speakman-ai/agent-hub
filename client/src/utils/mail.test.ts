import { describe, it, expect } from 'vitest';
import { mailSenderName, formatMailDate } from './mail';

describe('mailSenderName', () => {
  it('extracts the display name from a named From header', () => {
    expect(mailSenderName('Jane Doe <jane@example.com>')).toBe('Jane Doe');
  });

  it('strips surrounding quotes from a quoted display name', () => {
    expect(mailSenderName('"Doe, Jane" <jane@example.com>')).toBe('Doe, Jane');
  });

  it('falls back to the address when the name is empty', () => {
    expect(mailSenderName('<jane@example.com>')).toBe('jane@example.com');
  });

  it('returns a bare address unchanged', () => {
    expect(mailSenderName('jane@example.com')).toBe('jane@example.com');
  });

  it('handles null / empty input', () => {
    expect(mailSenderName(null)).toBe('Unknown sender');
    expect(mailSenderName('   ')).toBe('Unknown sender');
  });
});

describe('formatMailDate', () => {
  const now = new Date('2026-07-07T12:00:00Z');

  it('shows a time for a same-day message (from internalDate)', () => {
    const sameDay = new Date('2026-07-07T09:41:00Z').getTime().toString();
    // Assert it looks like a clock time, not a date, without pinning the locale/zone.
    expect(formatMailDate(sameDay, null, now)).toMatch(/\d{1,2}:\d{2}/);
  });

  it('shows a month/day for an older message in the same year', () => {
    const older = new Date('2026-06-12T09:00:00Z').getTime().toString();
    expect(formatMailDate(older, null, now)).toMatch(/Jun/);
    expect(formatMailDate(older, null, now)).not.toMatch(/2026/);
  });

  it('includes the year for a prior-year message', () => {
    const lastYear = new Date('2025-07-12T09:00:00Z').getTime().toString();
    expect(formatMailDate(lastYear, null, now)).toMatch(/2025/);
  });

  it('falls back to the Date header when internalDate is missing', () => {
    expect(formatMailDate(null, 'Sat, 12 Jul 2025 09:00:00 +0000', now)).toMatch(/2025/);
  });

  it('returns an empty string when nothing is parseable', () => {
    expect(formatMailDate(null, null, now)).toBe('');
    expect(formatMailDate('not-a-number', 'garbage', now)).toBe('');
  });
});
