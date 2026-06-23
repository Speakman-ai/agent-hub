import { describe, it, expect } from 'vitest';
import {
  columnDroppableId,
  isColumnDroppableId,
  sortedColumnCards,
  resolveDropTarget,
  computeMoveUpdates,
  isAfterMidpoint,
  arrayMove,
} from './kanbanReorder';

// A dnd-kit-style rect (top/height are all the before/after math needs).
const rect = (top: any, height: any = 100) => ({ top, height });

const card = (id: any, column_id: any, position: any, extra: any = {}) => ({
  id,
  column_id,
  position,
  ...extra,
});

describe('columnDroppableId / isColumnDroppableId', () => {
  it('round-trips a column id and detects the droppable form', () => {
    const id = columnDroppableId('col-todo');
    expect(id!).toBe('column:col-todo');
    expect(isColumnDroppableId(id)).toBe(true);
  });

  it('does not treat a bare card id as a column droppable', () => {
    expect(isColumnDroppableId('card-a')).toBe(false);
    expect(isColumnDroppableId(123)).toBe(false);
    expect(isColumnDroppableId(null)).toBe(false);
  });
});

describe('sortedColumnCards', () => {
  it('returns only the column cards, position-ordered', () => {
    const cards = [
      card('a', 'col-1', 2),
      card('b', 'col-2', 0),
      card('c', 'col-1', 0),
      card('d', 'col-1', 1),
    ];
    expect(sortedColumnCards(cards, 'col-1').map((c: any) => c.id)).toEqual(['c', 'd', 'a']);
  });
});

describe('arrayMove', () => {
  it('moves an item forward and backward without mutating the input', () => {
    const list = ['a', 'b', 'c', 'd'];
    expect(arrayMove(list, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(arrayMove(list, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(list!).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('isAfterMidpoint', () => {
  it('is true when the dragged center is past the over card midpoint (bottom half)', () => {
    // over card spans 0..100 (mid 50); dragged center at 80 → after.
    expect(isAfterMidpoint(rect(30, 100), rect(0, 100))).toBe(true);
  });

  it('is false on the top half and when rects are missing', () => {
    expect(isAfterMidpoint(rect(0, 100), rect(0, 100))).toBe(false); // mid vs mid → not past
    expect(isAfterMidpoint(rect(-30, 100), rect(0, 100))).toBe(false);
    expect(isAfterMidpoint(null, rect(0, 100))).toBe(false);
    expect(isAfterMidpoint(rect(0, 100), null)).toBe(false);
  });
});

describe('resolveDropTarget', () => {
  const cards = [card('a', 'col-todo', 0), card('b', 'col-done', 0)];

  it('returns null for no over / self-drop', () => {
    expect(resolveDropTarget('a', null, cards)).toBeNull();
    expect(resolveDropTarget('a', 'a', cards)).toBeNull();
    expect(resolveDropTarget('a', { id: 'a' }, cards)).toBeNull();
  });

  it('resolves a CROSS-column droppable to an end-of-column drop', () => {
    // 'a' lives in col-todo; dropping onto col-done's container appends there.
    expect(resolveDropTarget('a', 'column:col-done', cards)).toEqual({
      targetColumnId: 'col-done',
      overCardId: null,
      after: false,
    });
  });

  it('treats a SAME-column container/whitespace drop as a no-op (preserve position)', () => {
    // 'a' lives in col-todo; releasing into col-todo whitespace must NOT append
    // it to the end — that would silently relocate a card the user didn't move.
    expect(resolveDropTarget('a', 'column:col-todo', cards)).toBeNull();
    expect(resolveDropTarget('a', { id: 'column:col-todo', rect: rect(0, 400) }, cards)).toBeNull();
  });

  it('resolves a bare card id to that card column + id, defaulting to before', () => {
    expect(resolveDropTarget('a', 'b', cards)).toEqual({
      targetColumnId: 'col-done',
      overCardId: 'b',
      after: false,
    });
  });

  it('carries after=true when the dnd-kit over object + rects say bottom half', () => {
    // dragged clone centered below b's midpoint → after.
    const over = { id: 'b', rect: rect(0, 100) };
    expect(resolveDropTarget('a', over, cards, rect(40, 100))).toEqual({
      targetColumnId: 'col-done',
      overCardId: 'b',
      after: true,
    });
  });

  it('carries after=false when the rects say top half', () => {
    const over = { id: 'b', rect: rect(0, 100) };
    expect(resolveDropTarget('a', over, cards, rect(-40, 100))).toEqual({
      targetColumnId: 'col-done',
      overCardId: 'b',
      after: false,
    });
  });

  it('returns null when the over card is unknown', () => {
    expect(resolveDropTarget('a', 'ghost', cards)).toBeNull();
  });
});

describe('computeMoveUpdates — within-column reorder', () => {
  it('moving a later card up renumbers the displaced cards', () => {
    const cards = [card('a', 'col', 0), card('b', 'col', 1), card('c', 'col', 2)];
    // Drop C onto A's slot → order becomes C, A, B.
    const updates = computeMoveUpdates(cards, 'c', 'col', 'a');
    const byId = Object.fromEntries(updates.map((u: any) => [u.id, u]));
    expect(byId['c']).toEqual({ id: 'c', columnId: 'col', position: 0 });
    expect(byId['a']).toEqual({ id: 'a', columnId: 'col', position: 1 });
    expect(byId['b']).toEqual({ id: 'b', columnId: 'col', position: 2 });
  });

  it('moving a card down to the end (null over) appends it', () => {
    const cards = [card('a', 'col', 0), card('b', 'col', 1), card('c', 'col', 2)];
    // Drop A at end → order B, C, A.
    const updates = computeMoveUpdates(cards, 'a', 'col', null);
    const byId = Object.fromEntries(updates.map((u: any) => [u.id, u]));
    expect(byId['a'].position).toBe(2);
    expect(byId['b'].position).toBe(0);
    expect(byId['c'].position).toBe(1);
  });

  it('bottom-half drop onto a later card lands after it within the column', () => {
    const cards = [card('a', 'col', 0), card('b', 'col', 1), card('c', 'col', 2)];
    // Drag A onto B's bottom half → order B, A, C.
    const updates = computeMoveUpdates(cards, 'a', 'col', 'b', true);
    const byId = Object.fromEntries(updates.map((u: any) => [u.id, u]));
    expect(byId['b']).toEqual({ id: 'b', columnId: 'col', position: 0 });
    expect(byId['a']).toEqual({ id: 'a', columnId: 'col', position: 1 });
    expect(byId['c']).toBeUndefined();
  });

  it('returns [] when dropping a card onto its own slot (no-op)', () => {
    const cards = [card('a', 'col', 0), card('b', 'col', 1)];
    expect(computeMoveUpdates(cards, 'a', 'col', 'a')).toEqual([]);
    expect(computeMoveUpdates(cards, 'a', 'col', 'a', true)).toEqual([]);
  });
});

describe('computeMoveUpdates — cross-column move', () => {
  it('top-half drop (after=false) inserts BEFORE the hovered card', () => {
    const cards = [card('a', 'col-todo', 0), card('b', 'col-done', 0), card('c', 'col-done', 1)];
    // Drop A onto C's top half (col-done) → A lands between B@0 and C, at index 1.
    const updates = computeMoveUpdates(cards, 'a', 'col-done', 'c', false);
    const byId = Object.fromEntries(updates.map((u: any) => [u.id, u]));
    expect(byId['a']).toEqual({ id: 'a', columnId: 'col-done', position: 1 });
    expect(byId['c']).toEqual({ id: 'c', columnId: 'col-done', position: 2 });
    // B stays at 0 — no update emitted for it.
    expect(byId['b']).toBeUndefined();
  });

  it('bottom-half drop (after=true) inserts AFTER the hovered card', () => {
    // Regression guard: dropping onto the lower half of a card must land after
    // it, not before. (Reviewer-flagged: cross-column drops were always before.)
    const cards = [card('a', 'col-todo', 0), card('b', 'col-done', 0), card('c', 'col-done', 1)];
    // Drop A onto C's bottom half → A lands at the end (after C), index 2.
    const updates = computeMoveUpdates(cards, 'a', 'col-done', 'c', true);
    const byId = Object.fromEntries(updates.map((u: any) => [u.id, u]));
    expect(byId['a']).toEqual({ id: 'a', columnId: 'col-done', position: 2 });
    // B@0 and C@1 are unchanged — nothing shifts when appending after the last.
    expect(byId['b']).toBeUndefined();
    expect(byId['c']).toBeUndefined();
  });

  it('bottom-half drop onto a middle card inserts directly after it', () => {
    const cards = [
      card('a', 'col-todo', 0),
      card('b', 'col-done', 0),
      card('c', 'col-done', 1),
      card('d', 'col-done', 2),
    ];
    // Drop A onto B's bottom half → A between B and C (index 1).
    const updates = computeMoveUpdates(cards, 'a', 'col-done', 'b', true);
    const byId = Object.fromEntries(updates.map((u: any) => [u.id, u]));
    expect(byId['a']).toEqual({ id: 'a', columnId: 'col-done', position: 1 });
    expect(byId['c']).toEqual({ id: 'c', columnId: 'col-done', position: 2 });
    expect(byId['d']).toEqual({ id: 'd', columnId: 'col-done', position: 3 });
    expect(byId['b']).toBeUndefined();
  });

  it('appends to the target column when dropped on its empty space (null over)', () => {
    const cards = [card('a', 'col-todo', 0), card('b', 'col-done', 0)];
    const updates = computeMoveUpdates(cards, 'a', 'col-done', null);
    const byId = Object.fromEntries(updates.map((u: any) => [u.id, u]));
    expect(byId['a']).toEqual({ id: 'a', columnId: 'col-done', position: 1 });
    expect(byId['b']).toBeUndefined();
  });

  it('closes the gap left behind in the source column', () => {
    const cards = [card('a', 'col-todo', 0), card('b', 'col-todo', 1), card('c', 'col-todo', 2)];
    // Move B (middle) to empty col-done → A stays 0, C shifts 2→1.
    const updates = computeMoveUpdates(cards, 'b', 'col-done', null);
    const byId = Object.fromEntries(updates.map((u: any) => [u.id, u]));
    expect(byId['b']).toEqual({ id: 'b', columnId: 'col-done', position: 0 });
    expect(byId['c']).toEqual({ id: 'c', columnId: 'col-todo', position: 1 });
    expect(byId['a']).toBeUndefined();
  });
});

describe('computeMoveUpdates — guards', () => {
  it('returns [] for an unknown active card', () => {
    expect(computeMoveUpdates([card('a', 'col', 0)], 'ghost', 'col', null)).toEqual([]);
  });
});
