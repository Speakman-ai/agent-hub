import { describe, it, expect } from 'vitest';
import {
  toggleKanbanCardSelection,
  setKanbanColumnSelection,
  pruneKanbanSelection,
  isKanbanColumnFullySelected,
} from './kanbanSelection';

describe('toggleKanbanCardSelection', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];

  it('adds and removes a single card', () => {
    const r1 = toggleKanbanCardSelection(new Set(), 'b');
    expect([...r1.selected]).toEqual(['b']);
    expect(r1.anchorId).toBe('b');

    const r2 = toggleKanbanCardSelection(r1.selected, 'b');
    expect([...r2.selected]).toEqual([]);
    expect(r2.anchorId).toBe('b');
  });

  it('shift+click selects an inclusive range from the anchor', () => {
    const r1 = toggleKanbanCardSelection(new Set(), 'b', { orderedVisibleIds: order });
    const r2 = toggleKanbanCardSelection(r1.selected, 'd', {
      shiftKey: true,
      anchorId: r1.anchorId,
      orderedVisibleIds: order,
    });
    expect([...r2.selected].sort()).toEqual(['b', 'c', 'd']);
  });

  it('shift+click works when the anchor is after the clicked card', () => {
    const r1 = toggleKanbanCardSelection(new Set(), 'd', { orderedVisibleIds: order });
    const r2 = toggleKanbanCardSelection(r1.selected, 'b', {
      shiftKey: true,
      anchorId: r1.anchorId,
      orderedVisibleIds: order,
    });
    expect([...r2.selected].sort()).toEqual(['b', 'c', 'd']);
  });
});

describe('setKanbanColumnSelection', () => {
  it('selects all cards in a column', () => {
    const next = setKanbanColumnSelection(new Set(['x']), ['a', 'b'], true);
    expect([...next].sort()).toEqual(['a', 'b', 'x']);
  });

  it('deselects all cards in a column', () => {
    const next = setKanbanColumnSelection(new Set(['a', 'b', 'c']), ['a', 'b'], false);
    expect([...next]).toEqual(['c']);
  });
});

describe('pruneKanbanSelection', () => {
  it('removes stale ids', () => {
    const next = pruneKanbanSelection(new Set(['a', 'b', 'gone']), new Set(['a', 'b']));
    expect([...next]).toEqual(['a', 'b']);
  });
});

describe('isKanbanColumnFullySelected', () => {
  it('is false for empty columns', () => {
    expect(isKanbanColumnFullySelected(new Set(['a']), [])).toBe(false);
  });

  it('is true when every visible card is selected', () => {
    expect(isKanbanColumnFullySelected(new Set(['a', 'b']), ['a', 'b'])).toBe(true);
    expect(isKanbanColumnFullySelected(new Set(['a']), ['a', 'b'])).toBe(false);
  });
});
