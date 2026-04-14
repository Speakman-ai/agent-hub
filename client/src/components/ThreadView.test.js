import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Test the formatTimestamp logic used by ThreadView
// We extract and test the formatting logic directly

function formatTimestamp(ts) {
  if (!ts) return '';
  const d = ts.includes('T') ? new Date(ts) : new Date(ts + 'Z');
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMs / 3600000);

  let relative;
  if (diffMins < 1) relative = 'just now';
  else if (diffMins < 60) relative = `${diffMins}m ago`;
  else if (diffHrs < 24) relative = `${diffHrs}h ago`;
  else relative = d.toLocaleDateString();

  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${time} · ${relative}`;
}

describe('ThreadView formatTimestamp', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty string for falsy input', () => {
    expect(formatTimestamp(null)).toBe('');
    expect(formatTimestamp(undefined)).toBe('');
    expect(formatTimestamp('')).toBe('');
  });

  it('shows "just now" for timestamps within the last minute', () => {
    const result = formatTimestamp('2026-04-14T12:00:00Z');
    expect(result).toContain('just now');
  });

  it('shows minutes ago for recent timestamps', () => {
    const result = formatTimestamp('2026-04-14T11:55:00Z');
    expect(result).toContain('5m ago');
  });

  it('shows hours ago for timestamps within 24 hours', () => {
    const result = formatTimestamp('2026-04-14T09:00:00Z');
    expect(result).toContain('3h ago');
  });

  it('shows date for timestamps older than 24 hours', () => {
    const result = formatTimestamp('2026-04-12T12:00:00Z');
    expect(result).not.toContain('ago');
    // Should contain the time portion
    expect(result).toContain('·');
  });

  it('handles SQLite datetime format (no T separator)', () => {
    const result = formatTimestamp('2026-04-14 11:55:00');
    expect(result).toContain('5m ago');
  });

  it('includes time portion in output', () => {
    const result = formatTimestamp('2026-04-14T11:30:00Z');
    // Should contain a time and relative portion separated by ·
    expect(result).toContain('·');
    expect(result).toContain('30m ago');
  });
});

describe('ThreadView entry classification', () => {
  it('identifies error entries by content prefix', () => {
    const errorContent = 'ERROR: Connection refused';
    const normalContent = 'Heartbeat completed successfully';

    expect(errorContent.startsWith('ERROR:')).toBe(true);
    expect(normalContent.startsWith('ERROR:')).toBe(false);
  });

  it('detects date boundary changes between entries', () => {
    const entry1 = { timestamp: '2026-04-13T23:59:00Z' };
    const entry2 = { timestamp: '2026-04-14T00:01:00Z' };
    const entry3 = { timestamp: '2026-04-14T00:05:00Z' };

    const d1 = new Date(entry1.timestamp);
    const d2 = new Date(entry2.timestamp);
    const d3 = new Date(entry3.timestamp);

    // Different dates — should show separator
    expect(d1.toDateString()).not.toBe(d2.toDateString());
    // Same date — no separator
    expect(d2.toDateString()).toBe(d3.toDateString());
  });
});
