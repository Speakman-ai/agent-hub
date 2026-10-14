import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComposerMention } from '@shared/utils/hubChatRefs';
import { caretAfterEdit, createEditTracker, editReadings } from './composerEdit';

const BOB: ComposerMention = { display: '@bob', token: '@[bob](user:u1)', at: 0 };
const sel = (n: number) => ({ start: n, end: n });

describe('editReadings', () => {
  it('lists both readings when a repeated paste is ambiguous', () => {
    // Caret moved to 0, then a caret of 5 was reported: either the paste
    // happened at 0 (5 is its result) or the caret moved to 5 first.
    expect(editReadings('@bob ', '@bob @bob ', { since: [sel(0), sel(5)], after: null })).toEqual([
      5, 10,
    ]);
  });
  it('has one reading when the history settles it', () => {
    expect(editReadings('@bob ', '@bob @bob ', { since: [sel(0)], after: null })).toEqual([5]);
    expect(editReadings('@bob ', '@bob @bob ', { since: [sel(5), sel(10)], after: null })).toEqual([
      10,
    ]);
  });
  it('reads backspace, forward delete and replacing a selection', () => {
    expect(editReadings('ab cd', 'abcd', { since: [], after: sel(3) })).toEqual([2]);
    expect(editReadings('ab cd', 'abcd', { since: [], after: sel(2) })).toEqual([2]);
    expect(
      editReadings('@bob x @bob', '@bob y @bob', { since: [{ start: 5, end: 6 }], after: null }),
    ).toEqual([6]);
  });
  it('falls back to the text diff with no selection at all', () => {
    expect(editReadings('hi', 'hi @b', { since: [], after: null })).toEqual([5]);
    expect(caretAfterEdit('hi', 'hi @b')).toBe(5);
  });
});

describe('createEditTracker', () => {
  afterEach(() => vi.useRealTimers());

  it('selection first: a prefix paste moves the tracked mention to the second copy', () => {
    const t = createEditTracker();
    t.onSelection(sel(0), '@bob ');
    t.onSelection(sel(5), '@bob ');
    const r = t.onText('@bob ', '@bob @bob ', [BOB]);
    expect(r).toEqual({ caret: 5, mentions: [{ ...BOB, at: 5 }] });
    t.dispose();
  });

  it('text first: an append is corrected by the caret reported after the text', () => {
    const t = createEditTracker();
    t.onSelection(sel(5), '@bob ');
    const provisional = t.onText('@bob ', '@bob @bob ', [BOB]);
    expect(provisional.caret).toBe(5);
    const fix = t.onSelection(sel(10), '@bob @bob ');
    expect(fix).toEqual({ caret: 10, mentions: [BOB] });
    t.dispose();
  });

  it('text first: a confirming caret changes nothing', () => {
    const t = createEditTracker();
    t.onSelection(sel(0), '@bob ');
    t.onSelection(sel(5), '@bob ');
    t.onText('@bob ', '@bob @bob ', [BOB]);
    expect(t.onSelection(sel(5), '@bob @bob ')).toBeNull();
    t.dispose();
  });

  it('a later caret move cannot reinterpret a settled edit', () => {
    vi.useFakeTimers();
    const t = createEditTracker(100);
    t.onSelection(sel(5), '@bob ');
    t.onText('@bob ', '@bob @bob ', [BOB]);
    vi.advanceTimersByTime(101);
    expect(t.onSelection(sel(10), '@bob @bob ')).toBeNull();
  });

  it('a further edit settles the previous one', () => {
    const t = createEditTracker();
    t.onSelection(sel(5), '@bob ');
    t.onText('@bob ', '@bob @bob ', [BOB]);
    t.onText('@bob @bob ', '@bob @bob x', [{ ...BOB, at: 5 }]);
    expect(t.onSelection(sel(10), '@bob @bob x')).toBeNull();
    t.dispose();
  });

  it('drops selection history when the text was replaced from outside', () => {
    const t = createEditTracker();
    t.onSelection(sel(0), '@bob ');
    t.onSelection(sel(5), '@bob ');
    // The draft was swapped (e.g. a message opened for editing) before typing.
    const r = t.onText('x @bob ', 'x @bob @bob ', [{ ...BOB, at: 2 }]);
    // The old text's history would read this as an insert at 5 (caret 10);
    // with no selection for this text, only the text diff decides.
    expect(r.caret).not.toBe(10);
    expect(r.caret).toBe(caretAfterEdit('x @bob ', 'x @bob @bob '));
    t.dispose();
  });
});
