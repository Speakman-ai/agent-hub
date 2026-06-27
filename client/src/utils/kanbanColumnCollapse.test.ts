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
});
