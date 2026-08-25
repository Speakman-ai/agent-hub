// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
  formatEntryTimestamp,
  shouldShowDateSeparator,
  mergeLiveThread,
  mergeLiveEntry,
  applyEntryUnread,
  clearProjectUnread,
  excludeRetiredHeartbeatThreads,
} from './threads';
describe('formatEntryTimestamp', () => {
  it('returns empty string for falsy input', () => {
    expect(formatEntryTimestamp('')).toBe('');
    expect(formatEntryTimestamp(null)).toBe('');
    expect(formatEntryTimestamp(undefined)).toBe('');
  });
  it('emits "just now" for the same instant', () => {
    const now = new Date('2026-04-18T03:45:10Z');
    const result = formatEntryTimestamp('2026-04-18T03:45:05Z', now);
    expect(result).toMatch(/just now$/);
  });
  it('emits "Nm ago" within the hour', () => {
    const now = new Date('2026-04-18T03:45:00Z');
    const result = formatEntryTimestamp('2026-04-18T03:40:00Z', now);
    expect(result).toMatch(/5m ago$/);
  });
  it('emits "Nh ago" within the day', () => {
    const now = new Date('2026-04-18T05:00:00Z');
    const result = formatEntryTimestamp('2026-04-18T01:00:00Z', now);
    expect(result).toMatch(/4h ago$/);
  });
  it('treats SQLite timestamps (no T) as UTC', () => {
    // Same instant, one with "T"/"Z" and one bare — both should diff to 0m
    const now = new Date('2026-04-18T03:45:30Z');
    const iso = formatEntryTimestamp('2026-04-18T03:45:00Z', now);
    const sqlite = formatEntryTimestamp('2026-04-18 03:45:00', now);
    // Both should say "just now" (within 30s)
    expect(iso).toMatch(/just now$/);
    expect(sqlite).toMatch(/just now$/);
  });
});
describe('shouldShowDateSeparator', () => {
  it('returns false for empty entry timestamp', () => {
    expect(shouldShowDateSeparator(null, {})).toBe(false);
    expect(shouldShowDateSeparator({ timestamp: '2026-04-18T00:00:00Z' }, {})).toBe(false);
  });
  it('returns true when there is no previous entry (first entry)', () => {
    expect(shouldShowDateSeparator(null, { timestamp: '2026-04-18T00:00:00Z' })).toBe(true);
  });
  it('returns false when same calendar day', () => {
    expect(
      shouldShowDateSeparator(
        { timestamp: '2026-04-18T12:00:00Z' },
        { timestamp: '2026-04-18T18:00:00Z' },
      ),
    ).toBe(false);
  });
  it('returns true when the day rolls over', () => {
    expect(
      shouldShowDateSeparator(
        { timestamp: '2026-04-17T23:59:00Z' },
        { timestamp: '2026-04-19T05:00:00Z' },
      ),
    ).toBe(true);
  });
  it('handles SQLite (no T) previous timestamps', () => {
    expect(
      shouldShowDateSeparator(
        { timestamp: '2026-04-17 23:59:00' },
        { timestamp: '2026-04-18T05:00:00Z' },
      ),
    ).toBe(true);
  });
});
describe('mergeLiveThread', () => {
  it('prepends a new thread', () => {
    const existing = [{ id: 'a' }, { id: 'b' }];
    const next = mergeLiveThread(existing, { id: 'c' });
    expect(next).toEqual([{ id: 'c' }, { id: 'a' }, { id: 'b' }]);
  });
  it('is a no-op if the thread is already present', () => {
    const existing = [{ id: 'a' }, { id: 'b' }];
    const next = mergeLiveThread(existing, { id: 'a' });
    expect(next).toBe(existing);
  });
  it('ignores threads without an id', () => {
    const existing = [{ id: 'a' }];
    expect(mergeLiveThread(existing, null)).toBe(existing);
    expect(mergeLiveThread(existing, {})).toBe(existing);
  });
});
describe('mergeLiveEntry', () => {
  it('appends a new entry', () => {
    const existing = [{ id: '1' }, { id: '2' }];
    expect(mergeLiveEntry(existing, { id: '3' })).toEqual([{ id: '1' }, { id: '2' }, { id: '3' }]);
  });
  it('is a no-op if the entry is already present', () => {
    const existing = [{ id: '1' }];
    expect(mergeLiveEntry(existing, { id: '1' })).toBe(existing);
  });
  it('ignores entries without an id', () => {
    const existing = [{ id: '1' }];
    expect(mergeLiveEntry(existing, undefined)).toBe(existing);
  });
});
describe('applyEntryUnread', () => {
  it('increments the counter for a project when not viewing the thread', () => {
    const next = applyEntryUnread({}, { projectId: 'p1', threadId: 't1' }, null);
    expect(next).toEqual({ p1: 1 });
  });
  it('is a no-op when the user is viewing that thread', () => {
    const counts = { p1: 2 };
    const next = applyEntryUnread(counts, { projectId: 'p1', threadId: 't1' }, 't1');
    expect(next).toBe(counts);
  });
  it('increments an existing counter', () => {
    const next = applyEntryUnread({ p1: 3, p2: 1 }, { projectId: 'p1', threadId: 't1' }, 't2');
    expect(next).toEqual({ p1: 4, p2: 1 });
  });
  it('is a no-op when projectId is missing', () => {
    const counts = { p1: 1 };
    expect(applyEntryUnread(counts, { threadId: 't1' }, null)).toBe(counts);
  });
  it('is a no-op for retired heartbeat threads', () => {
    const counts = { p1: 1 };
    expect(
      applyEntryUnread(counts, { projectId: 'p1', threadId: 't1', threadType: 'heartbeat' }, null),
    ).toBe(counts);
  });
  it('returns a new object (does not mutate)', () => {
    const counts = { p1: 1 };
    const next = applyEntryUnread(counts, { projectId: 'p1', threadId: 't1' }, null);
    expect(next).not.toBe(counts);
    expect(counts).toEqual({ p1: 1 });
  });
});
describe('excludeRetiredHeartbeatThreads', () => {
  it('hides historical heartbeat rows from the thread list', () => {
    expect(
      excludeRetiredHeartbeatThreads([
        { id: 'h', type: 'heartbeat' },
        { id: 'c', type: 'cron' },
      ]),
    ).toEqual([{ id: 'c', type: 'cron' }]);
  });
});
describe('clearProjectUnread', () => {
  it('removes the entry for the given project', () => {
    expect(clearProjectUnread({ p1: 3, p2: 1 }, 'p1')).toEqual({ p2: 1 });
  });
  it('is a no-op if the project has no unread count', () => {
    const counts = { p2: 1 };
    expect(clearProjectUnread(counts, 'p1')).toBe(counts);
  });
  it('is a no-op for a falsy projectId', () => {
    const counts = { p1: 1 };
    expect(clearProjectUnread(counts, null)).toBe(counts);
    expect(clearProjectUnread(counts, '')).toBe(counts);
  });
});
