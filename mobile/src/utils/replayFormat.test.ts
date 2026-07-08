import { describe, it, expect } from 'vitest';
import {
  formatReplayDuration,
  formatBytes,
  formatPageUrl,
  formatSessionStart,
  formatCaptureDate,
} from './replayFormat';

describe('formatReplayDuration', () => {
  it('formats sub-minute and minute+second spans', () => {
    expect(formatReplayDuration(5000)).toBe('5s');
    expect(formatReplayDuration(65_000)).toBe('1m 5s');
    expect(formatReplayDuration(3_600_000)).toBe('60m 0s');
  });
  it('clamps null / negative / non-finite to 0s', () => {
    expect(formatReplayDuration(null)).toBe('0s');
    expect(formatReplayDuration(-10)).toBe('0s');
    expect(formatReplayDuration(NaN)).toBe('0s');
  });
});

describe('formatBytes', () => {
  it('scales through the unit table', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1_500_000)).toBe('1.4 MB');
  });
  it('returns 0 B for empty / invalid input', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(null)).toBe('0 B');
  });
});

describe('formatPageUrl', () => {
  it('reduces an absolute URL to host + path', () => {
    expect(formatPageUrl('https://app.example.com/settings/rum?x=1')).toBe(
      'app.example.com/settings/rum',
    );
  });
  it('drops a bare root path', () => {
    expect(formatPageUrl('https://example.com/')).toBe('example.com');
  });
  it('passes through non-URLs and dashes empty', () => {
    expect(formatPageUrl('not a url')).toBe('not a url');
    expect(formatPageUrl('')).toBe('—');
    expect(formatPageUrl(null)).toBe('—');
  });
});

describe('formatSessionStart', () => {
  it('dashes null and invalid epochs', () => {
    expect(formatSessionStart(null)).toBe('—');
    expect(formatSessionStart(NaN)).toBe('—');
  });
  it('renders a real timestamp', () => {
    expect(formatSessionStart(0)).not.toBe('—');
  });
});

describe('formatCaptureDate', () => {
  it('returns empty for a missing timestamp', () => {
    expect(formatCaptureDate(null)).toBe('');
    expect(formatCaptureDate('')).toBe('');
  });
  it('parses a bare (space-separated) SQLite datetime as the correct UTC instant', () => {
    // The space must be normalized to `T` before appending `Z` — a raw
    // `'2026-07-08 03:00:00Z'` is non-ISO and not guaranteed to parse under
    // Hermes. Assert the resolved instant, not just non-empty, so a silent
    // parse failure (which would fall back to the raw string) is caught.
    const expected = new Date(Date.UTC(2026, 6, 8, 3, 0, 0)).toLocaleString();
    expect(formatCaptureDate('2026-07-08 03:00:00')).toBe(expected);
  });
  it('accepts an ISO-8601 timestamp unchanged', () => {
    const expected = new Date('2026-07-08T03:00:00Z').toLocaleString();
    expect(formatCaptureDate('2026-07-08T03:00:00Z')).toBe(expected);
  });
  it('falls back to the raw string when unparseable', () => {
    expect(formatCaptureDate('not-a-date')).toBe('not-a-date');
  });
});
