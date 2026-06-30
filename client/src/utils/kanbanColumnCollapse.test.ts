import { describe, it, expect, beforeEach } from 'vitest';
import {
  kanbanCollapsedColumnsKey,
  readCollapsedColumnIds,
  writeCollapsedColumnIds,
  pruneCollapsedColumnIds,
} from './kanbanColumnCollapse';

describe('kanbanColumnCollapse', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips collapsed column ids per project', () => {
    writeCollapsedColumnIds('p1', new Set(['col-a', 'col-b']));
    expect(readCollapsedColumnIds('p1')).toEqual(new Set(['col-a', 'col-b']));
    expect(readCollapsedColumnIds('p2')).toEqual(new Set());
  });

  it('removes storage when nothing is collapsed', () => {
    writeCollapsedColumnIds('p1', new Set(['col-a']));
    writeCollapsedColumnIds('p1', new Set());
    expect(localStorage.getItem(kanbanCollapsedColumnsKey('p1'))).toBeNull();
  });

  it('prunes ids that no longer exist on the board', () => {
    const pruned = pruneCollapsedColumnIds(new Set(['a', 'b', 'gone']), ['a', 'b']);
    expect(pruned).toEqual(new Set(['a', 'b']));
  });

  // Load-bearing invariant: a no-op prune MUST return the SAME Set reference.
  // KanbanBoard's controlled mode notifies its parent only when the pruned set
  // !== the current one; if prune returned a new-but-equal Set on a no-op, the
  // parent setState → re-render → prune → notify cycle would loop forever.
  it('returns the same Set reference when nothing is pruned', () => {
    const set = new Set(['a', 'b']);
    expect(pruneCollapsedColumnIds(set, ['a', 'b'])).toBe(set);
    expect(pruneCollapsedColumnIds(set, ['a', 'b', 'c'])).toBe(set);
  });
});
