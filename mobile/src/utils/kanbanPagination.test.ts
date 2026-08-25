// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
  KANBAN_PAGE_SIZE,
  appendCardPage,
  pagingEntry,
  seedPagingFromBoard,
  loadedCountsByColumn,
  canLoadMore,
} from './kanbanPagination';
const card = (id: any, columnId: any = 'c1') => ({ id, column_id: columnId });
describe('KANBAN_PAGE_SIZE', () => {
  it('matches the web client / server default', () => {
    expect(KANBAN_PAGE_SIZE).toBe(50);
  });
});
describe('appendCardPage', () => {
  it('appends a fresh page preserving order', () => {
    const existing = [card('a'), card('b')];
    const result = appendCardPage(existing, [card('c'), card('d')]);
    expect(result.map((c: any) => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('dedupes cards already present by id', () => {
    const existing = [card('a'), card('b')];
    const result = appendCardPage(existing, [card('b'), card('c')]);
    expect(result.map((c: any) => c.id)).toEqual(['a', 'b', 'c']);
  });
  it('returns the same reference when the page is empty (no-op setState)', () => {
    const existing = [card('a')];
    expect(appendCardPage(existing, [])).toBe(existing);
  });
  it('returns the same reference when every incoming card is a duplicate', () => {
    const existing = [card('a'), card('b')];
    expect(appendCardPage(existing, [card('a'), card('b')])).toBe(existing);
  });
  it('tolerates null / undefined inputs', () => {
    expect(appendCardPage(null, [card('a')]).map((c: any) => c.id)).toEqual(['a']);
    expect(appendCardPage([card('a')], null).map((c: any) => c.id)).toEqual(['a']);
    expect(appendCardPage(undefined, undefined)).toEqual([]);
  });
});
describe('pagingEntry', () => {
  it('marks hasMore when a cursor is present', () => {
    expect(pagingEntry('cur', 120, 50)).toEqual({
      nextCursor: 'cur',
      hasMore: true,
      loading: false,
      total: 120,
    });
  });
  it('marks the column complete when nextCursor is null/undefined', () => {
    expect(pagingEntry(null, 12, 12)).toEqual({
      nextCursor: null,
      hasMore: false,
      loading: false,
      total: 12,
    });
    expect(pagingEntry(undefined, 5, 5).hasMore).toBe(false);
  });
  it('falls back to loaded count then 0 for total', () => {
    expect(pagingEntry(null, undefined, 7).total).toBe(7);
    expect(pagingEntry(null, undefined, undefined).total).toBe(0);
  });
});
describe('seedPagingFromBoard', () => {
  const columns = [{ id: 'c1' }, { id: 'c2' }];
  const cards = [card('a', 'c1'), card('b', 'c1'), card('c', 'c2')];
  it('seeds each column from cursors + counts', () => {
    const paging = seedPagingFromBoard({
      columns,
      cards,
      cursors: { c1: 'cur1', c2: null },
      counts: { c1: 130, c2: 1 },
    });
    expect(paging.c1).toEqual({ nextCursor: 'cur1', hasMore: true, loading: false, total: 130 });
    expect(paging.c2).toEqual({ nextCursor: null, hasMore: false, loading: false, total: 1 });
  });
  it('falls back to the loaded count when counts is missing', () => {
    const paging = seedPagingFromBoard({ columns, cards, cursors: {}, counts: {} });
    expect(paging.c1.total).toBe(2);
    expect(paging.c2.total).toBe(1);
    expect(paging.c1.hasMore).toBe(false);
  });
  it('handles a missing/empty payload without throwing', () => {
    expect(seedPagingFromBoard()).toEqual({});
    expect(seedPagingFromBoard({ columns: [] })).toEqual({});
  });
});
describe('loadedCountsByColumn', () => {
  it('counts cards per column', () => {
    const cards = [card('a', 'c1'), card('b', 'c1'), card('c', 'c2')];
    expect(loadedCountsByColumn(cards)).toEqual({ c1: 2, c2: 1 });
  });
  it('returns {} for empty / nullish input', () => {
    expect(loadedCountsByColumn([])).toEqual({});
    expect(loadedCountsByColumn(null)).toEqual({});
  });
  it('skips nullish entries', () => {
    expect(loadedCountsByColumn([card('a', 'c1'), null, undefined])).toEqual({ c1: 1 });
  });
});
describe('canLoadMore', () => {
  it('is true only when there is a cursor, more pages, and no fetch in flight', () => {
    expect(canLoadMore({ hasMore: true, nextCursor: 'cur', loading: false })).toBe(true);
  });
  it('is false at the end of the column', () => {
    expect(canLoadMore({ hasMore: false, nextCursor: null, loading: false })).toBe(false);
  });
  it('is false while a page is already loading', () => {
    expect(canLoadMore({ hasMore: true, nextCursor: 'cur', loading: true })).toBe(false);
  });
  it('is false when there is no cursor even if hasMore is set', () => {
    expect(canLoadMore({ hasMore: true, nextCursor: null, loading: false })).toBe(false);
  });
  it('is false for a missing entry', () => {
    expect(canLoadMore(undefined)).toBe(false);
    expect(canLoadMore(null)).toBe(false);
  });
});
