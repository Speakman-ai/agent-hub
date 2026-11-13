import { describe, expect, it } from 'vitest';
import { isSessionPinned, pinnedSessionsFirst } from './sessionPins';

type Row = { id: string; updated_at?: string; pinned_at?: string | null };
const ids = (rows: Row[]) => pinnedSessionsFirst(rows).map((r) => r.id);
const setPin = (rows: Row[], id: string, pinnedAt: string | null) =>
  rows.map((r) => (r.id === id ? { ...r, pinned_at: pinnedAt } : r));

describe('pinnedSessionsFirst', () => {
  // As the server returns it: pinned first, then by updated_at DESC.
  const serverOrdered: Row[] = [
    { id: 'old', updated_at: '2026-01-01 00:00:00', pinned_at: '2026-01-05 00:00:00' },
    { id: 'newest', updated_at: '2026-01-03 00:00:00' },
    { id: 'middle', updated_at: '2026-01-02 00:00:00' },
  ];

  it('keeps the server order as-is', () => {
    expect(pinnedSessionsFirst(serverOrdered)).toBe(serverOrdered);
  });

  it('drops an unpinned session back to its recency slot', () => {
    expect(ids(setPin(serverOrdered, 'old', null))).toEqual(['newest', 'middle', 'old']);
  });

  it('orders the pinned group by recency after pinning another row', () => {
    expect(ids(setPin(serverOrdered, 'middle', '2026-01-06 00:00:00'))).toEqual([
      'middle',
      'old',
      'newest',
    ]);
  });

  it('compares SQLite and ISO timestamps as the same clock', () => {
    const rows: Row[] = [
      { id: 'sqlite', updated_at: '2026-01-02 10:00:00' },
      { id: 'iso', updated_at: '2026-01-02T11:00:00.000Z' },
    ];
    expect(ids(rows)).toEqual(['iso', 'sqlite']);
  });

  it('partitions in incoming order when timestamps are missing', () => {
    const rows: Row[] = [
      { id: 'a' },
      { id: 'b', pinned_at: '2026-01-02 00:00:00' },
      { id: 'c', pinned_at: null },
      { id: 'd', pinned_at: '2026-01-01 00:00:00' },
    ];
    expect(ids(rows)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('returns the same array when nothing is pinned and order already holds', () => {
    const rows: Row[] = [{ id: 'a' }, { id: 'b', pinned_at: null }];
    expect(pinnedSessionsFirst(rows)).toBe(rows);
  });
});

describe('isSessionPinned', () => {
  it('treats only a non-empty timestamp as pinned', () => {
    expect(isSessionPinned({ pinned_at: '2026-01-01 00:00:00' })).toBe(true);
    expect(isSessionPinned({ pinned_at: null })).toBe(false);
    expect(isSessionPinned({ pinned_at: '' })).toBe(false);
    expect(isSessionPinned(null)).toBe(false);
  });
});
