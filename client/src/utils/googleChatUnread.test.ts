import { describe, it, expect, beforeEach } from 'vitest';
import {
  isSpaceUnread,
  laterOf,
  loadSeen,
  markSeen,
  pruneSeen,
  saveSeen,
  spacesNeedingReadState,
  READ_STATE_RECHECK_MS,
  READ_STATE_WINDOW_MS,
  type GoogleReadCache,
  type SeenStore,
} from './googleChatUnread';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const seenAt = (since: string, spaces: Record<string, string> = {}): SeenStore => ({
  since,
  spaces,
});

describe('laterOf', () => {
  it('returns the later time from either side and tolerates nulls', () => {
    const a = '2026-10-09T10:00:00Z';
    const b = '2026-10-09T10:00:00.000000001Z';
    expect(laterOf(a, b)).toBe(b);
    expect(laterOf(b, a)).toBe(b);
    expect(laterOf(null, a)).toBe(a);
    expect(laterOf(a, undefined)).toBe(a);
    expect(laterOf(null, null)).toBeNull();
  });
});

describe('isSpaceUnread', () => {
  const space = { id: 'A', lastActiveTime: '2026-10-09T11:00:00Z' };

  it('uses the Google read position when it is known', () => {
    const seen = seenAt('2026-10-01T00:00:00Z');
    const google = (lastReadTime: string | null) => ({
      A: { lastReadTime, checkedActive: space.lastActiveTime, checkedAt: NOW },
    });
    expect(
      isSpaceUnread(space, { google: google('2026-10-09T10:00:00Z'), seen, useGoogle: true }),
    ).toBe(true);
    expect(
      isSpaceUnread(space, { google: google('2026-10-09T11:00:00Z'), seen, useGoogle: true }),
    ).toBe(false);
    // Never read in Google.
    expect(isSpaceUnread(space, { google: google(null), seen, useGoogle: true })).toBe(true);
  });

  it('counts what this browser showed as read even when Google lags behind', () => {
    const google = {
      A: { lastReadTime: '2026-10-09T09:00:00Z', checkedActive: null, checkedAt: NOW },
    };
    const seen = seenAt('2026-10-01T00:00:00Z', { A: '2026-10-09T11:00:00Z' });
    expect(isSpaceUnread(space, { google, seen, useGoogle: true })).toBe(false);
  });

  it('shows nothing for a space whose Google position is still unknown', () => {
    expect(
      isSpaceUnread(space, { google: {}, seen: seenAt('2026-10-01T00:00:00Z'), useGoogle: true }),
    ).toBe(false);
  });

  it('without read-state access, falls back to when tracking started', () => {
    const opts = (since: string) => ({ google: {}, seen: seenAt(since), useGoogle: false });
    expect(isSpaceUnread(space, opts('2026-10-09T10:00:00Z'))).toBe(true);
    expect(isSpaceUnread(space, opts('2026-10-09T11:30:00Z'))).toBe(false);
  });

  it('never marks a space without activity unread', () => {
    expect(
      isSpaceUnread(
        { id: 'A', lastActiveTime: null },
        { google: {}, seen: seenAt('2020-01-01T00:00:00Z'), useGoogle: false },
      ),
    ).toBe(false);
  });
});

describe('seen store', () => {
  beforeEach(() => localStorage.clear());

  it('starts tracking now, then round-trips per user', () => {
    const first = loadSeen('u1', NOW);
    expect(first).toEqual({ since: new Date(NOW).toISOString(), spaces: {} });
    const marked = markSeen(first, 'A', '2026-10-09T11:00:00Z');
    saveSeen('u1', marked);
    expect(loadSeen('u1', NOW + 1000)).toEqual(marked);
    expect(loadSeen('u2', NOW).spaces).toEqual({});
  });

  it('only moves a space forward', () => {
    const store = seenAt('2026-10-01T00:00:00Z', { A: '2026-10-09T11:00:00Z' });
    expect(markSeen(store, 'A', '2026-10-09T10:00:00Z')).toBe(store);
    expect(markSeen(store, 'A', null)).toBe(store);
    expect(markSeen(store, 'A', '2026-10-09T11:00:01Z').spaces.A).toBe('2026-10-09T11:00:01Z');
  });

  it('prunes spaces no longer listed', () => {
    const store = seenAt('2026-10-01T00:00:00Z', { A: 'x', B: 'y' });
    expect(pruneSeen(store, ['A', 'B'])).toBe(store);
    expect(pruneSeen(store, ['A']).spaces).toEqual({ A: 'x' });
  });

  it('ignores a corrupt stored value', () => {
    localStorage.setItem('agenthub.googleChat.seen:u1', '{not json');
    expect(loadSeen('u1', NOW).spaces).toEqual({});
  });
});

describe('spacesNeedingReadState', () => {
  const recent = (id: string, minutesAgo: number) => ({
    id,
    lastActiveTime: new Date(NOW - minutesAgo * 60_000).toISOString(),
  });

  it('checks unchecked and changed spaces, newest first, skipping idle and in-flight ones', () => {
    const spaces = [
      recent('OLD', READ_STATE_WINDOW_MS / 60_000 + 10),
      recent('B', 30),
      recent('A', 5),
      recent('FLIGHT', 1),
      recent('SAME', 60),
    ];
    const google = {
      SAME: {
        lastReadTime: spaces[4].lastActiveTime,
        checkedActive: spaces[4].lastActiveTime,
        checkedAt: NOW,
      },
    };
    expect(spacesNeedingReadState(spaces, google, { now: NOW, skip: new Set(['FLIGHT']) })).toEqual(
      ['A', 'B'],
    );
  });

  it('re-checks a still-unread space once the recheck interval passes', () => {
    const space = recent('A', 5);
    const google = {
      A: { lastReadTime: null, checkedActive: space.lastActiveTime, checkedAt: NOW },
    };
    expect(spacesNeedingReadState([space], google, { now: NOW + 1000 })).toEqual([]);
    expect(spacesNeedingReadState([space], google, { now: NOW + READ_STATE_RECHECK_MS })).toEqual([
      'A',
    ]);
  });

  it('puts never-checked spaces ahead of re-checks, and rotates re-checks oldest first', () => {
    const spaces = [recent('A', 1), recent('B', 2), recent('C', 3), recent('NEW', 4)];
    const entry = (id: string, checkedAt: number) => ({
      lastReadTime: null,
      checkedActive: spaces.find((s) => s.id === id)!.lastActiveTime,
      checkedAt,
    });
    const google = { A: entry('A', NOW), B: entry('B', NOW - 1000), C: entry('C', NOW - 5000) };
    const now = NOW + READ_STATE_RECHECK_MS;
    expect(spacesNeedingReadState(spaces, google, { now, limit: 3 })).toEqual(['NEW', 'C', 'B']);
  });

  const space20 = () => Array.from({ length: 20 }, (_, i) => recent(`S${i}`, i + 1));
  const unreadEntry = (space: { lastActiveTime: string }, checkedAt: number) => ({
    lastReadTime: null,
    checkedActive: space.lastActiveTime,
    checkedAt,
  });

  it('puts never-checked spaces ahead of due re-checks', () => {
    const spaces = space20();
    const google: GoogleReadCache = {};
    for (const s of spaces.slice(0, 15)) google[s.id] = unreadEntry(s, NOW);
    const due = spacesNeedingReadState(spaces, google, { now: NOW + READ_STATE_RECHECK_MS });
    expect(due.slice(0, 5)).toEqual(['S15', 'S16', 'S17', 'S18', 'S19']);
    expect(due).toHaveLength(15);
  });

  it('checks every unread space within two passes when re-checks keep coming due', () => {
    const spaces = space20();
    const google: GoogleReadCache = {};
    const checked = new Set<string>();
    let now = NOW;
    for (let pass = 0; pass < 2; pass++) {
      for (const id of spacesNeedingReadState(spaces, google, { now })) {
        checked.add(id);
        google[id] = unreadEntry(spaces.find((s) => s.id === id)!, now);
      }
      now += READ_STATE_RECHECK_MS;
    }
    expect(checked.size).toBe(20);
  });

  it('re-checks the spaces that waited longest first', () => {
    const spaces = space20();
    const google: GoogleReadCache = {};
    // S0 was checked most recently, S19 longest ago.
    spaces.forEach((s, i) => (google[s.id] = unreadEntry(s, NOW - i * 1000)));
    const due = spacesNeedingReadState(spaces, google, { now: NOW + READ_STATE_RECHECK_MS });
    expect(new Set(due)).toEqual(new Set(spaces.slice(5).map((s) => s.id)));
    expect(due[0]).toBe('S19');
  });

  it('caps the checks per pass', () => {
    const spaces = Array.from({ length: 30 }, (_, i) => recent(`S${i}`, i + 1));
    expect(spacesNeedingReadState(spaces, {}, { now: NOW, limit: 4 })).toEqual([
      'S0',
      'S1',
      'S2',
      'S3',
    ]);
  });
});
