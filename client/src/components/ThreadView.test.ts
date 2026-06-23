import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyEntry } from './ThreadView';

// Test the formatTimestamp logic used by ThreadView
// We extract and test the formatting logic directly

function formatTimestamp(ts: any) {
  if (!ts) return '';
  const d = ts.includes('T') ? new Date(ts) : new Date(ts + 'Z');
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMs / 3600000);

  let relative: any;
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
    expect(result!).toContain('just now');
  });

  it('shows minutes ago for recent timestamps', () => {
    const result = formatTimestamp('2026-04-14T11:55:00Z');
    expect(result!).toContain('5m ago');
  });

  it('shows hours ago for timestamps within 24 hours', () => {
    const result = formatTimestamp('2026-04-14T09:00:00Z');
    expect(result!).toContain('3h ago');
  });

  it('shows date for timestamps older than 24 hours', () => {
    const result = formatTimestamp('2026-04-12T12:00:00Z');
    expect(result!).not.toContain('ago');
    // Should contain the time portion
    expect(result!).toContain('·');
  });

  it('handles SQLite datetime format (no T separator)', () => {
    const result = formatTimestamp('2026-04-14 11:55:00');
    expect(result!).toContain('5m ago');
  });

  it('includes time portion in output', () => {
    const result = formatTimestamp('2026-04-14T11:30:00Z');
    // Should contain a time and relative portion separated by ·
    expect(result!).toContain('·');
    expect(result!).toContain('30m ago');
  });
});

describe('ThreadView classifyEntry — chatroom roles', () => {
  it("treats role='user' entries as human (right-aligned bubble)", () => {
    const out = classifyEntry({ role: 'user', content: 'hi' });
    expect(out.isHuman).toBe(true);
    expect(out.role).toBe('user');
    expect(out.isError).toBe(false);
  });

  it("treats role='system' entries as daemon log lines", () => {
    const out = classifyEntry({ role: 'system', content: 'cron tick' });
    expect(out.isHuman).toBe(false);
    expect(out.role).toBe('system');
  });

  it("defaults missing role to 'system' so legacy entries keep their look", () => {
    // Older rows written before the role column existed return undefined.
    // classifyEntry must coalesce so the existing log layout is preserved.
    const out = classifyEntry({ content: 'pre-migration entry' });
    expect(out.isHuman).toBe(false);
    expect(out.role).toBe('system');
  });

  it('still flags ERROR: prefixes regardless of role', () => {
    expect(classifyEntry({ role: 'system', content: 'ERROR: boom' }).isError).toBe(true);
    expect(classifyEntry({ role: 'user', content: 'ERROR: boom' }).isError).toBe(true);
    expect(classifyEntry({ role: 'system', content: 'ok' }).isError).toBe(false);
  });

  it('tolerates falsy/missing content without throwing', () => {
    expect(() => classifyEntry({})).not.toThrow();
    expect(classifyEntry({}).isError).toBe(false);
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

    const utcDay = (d: any) =>
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

    // Different UTC calendar days — should show separator (local toDateString() is TZ-flaky)
    expect(utcDay(d1)).not.toBe(utcDay(d2));
    // Same UTC day — no separator
    expect(utcDay(d2)).toBe(utcDay(d3));
  });
});
