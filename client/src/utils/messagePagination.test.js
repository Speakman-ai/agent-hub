import { describe, it, expect } from 'vitest';
import {
  MESSAGES_PAGE_SIZE,
  LOAD_OLDER_THRESHOLD_PX,
  shouldLoadOlder,
  inferHasMore,
  prependOlderMessages,
  restoredScrollTop,
} from './messagePagination.js';

/**
 * Covers the reverse-infinite-scroll logic used by App.jsx's chat loader:
 * when scrolling up triggers an older-page fetch, inferring there's more
 * history, prepending a page without duplicating already-loaded messages,
 * preserving the viewport after the prepend, and stopping at the start.
 */
describe('shouldLoadOlder — triggering the older-page fetch', () => {
  const base = { scrollTop: 0, hasMore: true, loading: false };

  it('triggers when scrolled within the threshold of the top', () => {
    expect(shouldLoadOlder({ ...base, scrollTop: 0 })).toBe(true);
    expect(shouldLoadOlder({ ...base, scrollTop: LOAD_OLDER_THRESHOLD_PX })).toBe(true);
  });

  it('does not trigger when still far from the top', () => {
    expect(shouldLoadOlder({ ...base, scrollTop: LOAD_OLDER_THRESHOLD_PX + 1 })).toBe(false);
    expect(shouldLoadOlder({ ...base, scrollTop: 5000 })).toBe(false);
  });

  it('does not trigger while a fetch is already in flight (no double-load)', () => {
    expect(shouldLoadOlder({ ...base, scrollTop: 0, loading: true })).toBe(false);
  });

  it('does not trigger once the start of the transcript is reached', () => {
    expect(shouldLoadOlder({ ...base, scrollTop: 0, hasMore: false })).toBe(false);
  });

  it('honors a custom threshold', () => {
    expect(shouldLoadOlder({ ...base, scrollTop: 100, threshold: 50 })).toBe(false);
    expect(shouldLoadOlder({ ...base, scrollTop: 40, threshold: 50 })).toBe(true);
  });
});

describe('inferHasMore — stopping at the end', () => {
  it('reports more history when a full page comes back', () => {
    expect(inferHasMore(MESSAGES_PAGE_SIZE)).toBe(true);
    expect(inferHasMore(MESSAGES_PAGE_SIZE + 5)).toBe(true);
  });

  it('reports no more history for a short or empty page', () => {
    expect(inferHasMore(MESSAGES_PAGE_SIZE - 1)).toBe(false);
    expect(inferHasMore(0)).toBe(false);
  });

  it('respects an explicit page size', () => {
    expect(inferHasMore(10, 10)).toBe(true);
    expect(inferHasMore(9, 10)).toBe(false);
  });
});

describe('prependOlderMessages — prepend without duplicates', () => {
  const msg = (id) => ({ id, content: id });

  it('prepends an older page ahead of the loaded window', () => {
    const prev = [msg('m3'), msg('m4')];
    const older = [msg('m1'), msg('m2')];
    const { messages, addedCount } = prependOlderMessages(prev, older);
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(addedCount).toBe(2);
  });

  it('drops ids already present (overlapping keyset boundary / WS dedup)', () => {
    const prev = [msg('m2'), msg('m3')];
    const older = [msg('m1'), msg('m2')]; // m2 overlaps
    const { messages, addedCount } = prependOlderMessages(prev, older);
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(addedCount).toBe(1);
  });

  it('returns the original array unchanged when the page is fully duplicate', () => {
    const prev = [msg('m1'), msg('m2')];
    const { messages, addedCount } = prependOlderMessages(prev, [msg('m1'), msg('m2')]);
    expect(messages).toBe(prev); // same reference → no re-render churn
    expect(addedCount).toBe(0);
  });

  it('handles a non-array / empty older page', () => {
    const prev = [msg('m1')];
    expect(prependOlderMessages(prev, []).addedCount).toBe(0);
    expect(prependOlderMessages(prev, undefined).addedCount).toBe(0);
  });
});

describe('restoredScrollTop — preserving the viewport', () => {
  it('shifts scrollTop down by exactly the height added above', () => {
    // Was scrolled to the top (0); prepend added 800px of older content.
    expect(
      restoredScrollTop({ prevScrollTop: 0, prevScrollHeight: 1200, newScrollHeight: 2000 }),
    ).toBe(800);
  });

  it('keeps a mid-scroll reader anchored on the same content', () => {
    expect(
      restoredScrollTop({ prevScrollTop: 150, prevScrollHeight: 1000, newScrollHeight: 1600 }),
    ).toBe(750);
  });

  it('is a no-op when nothing was added', () => {
    expect(
      restoredScrollTop({ prevScrollTop: 120, prevScrollHeight: 900, newScrollHeight: 900 }),
    ).toBe(120);
  });
});
