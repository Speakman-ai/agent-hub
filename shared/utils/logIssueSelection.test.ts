import { describe, it, expect } from 'vitest';
import {
  toggleSelectedId,
  pruneSelection,
  allVisibleSelected,
  toggleSelectAll,
  bulkActionAvailable,
  clearSubmittedIds,
  selectedStatuses,
  applyBulkUpdateToList,
  bulkResultMessage,
  type LogIssueStatus,
} from './logIssueSelection';

const issue = (id: string, status: LogIssueStatus) => ({ id, status });

describe('logIssueSelection', () => {
  it('toggles ids while preserving selection order', () => {
    expect(toggleSelectedId([], 'a')).toEqual(['a']);
    expect(toggleSelectedId(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleSelectedId(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('prunes ids that are no longer visible', () => {
    expect(pruneSelection(['a', 'b', 'c'], ['b', 'd'])).toEqual(['b']);
    expect(pruneSelection(['a'], [])).toEqual([]);
  });

  it('reports select-all state and toggles it', () => {
    expect(allVisibleSelected([], [])).toBe(false);
    expect(allVisibleSelected(['a'], ['a', 'b'])).toBe(false);
    expect(allVisibleSelected(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(toggleSelectAll(['a'], ['a', 'b'])).toEqual(['a', 'b']);
    expect(toggleSelectAll(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('clears only the submitted ids, keeping rows ticked mid-request', () => {
    // Regression: resetting the whole selection after a batch dropped rows the
    // user ticked while the request was in flight — they were never sent, so
    // they were never transitioned.
    expect(clearSubmittedIds(['a', 'b'], ['a'])).toEqual(['b']);
    expect(clearSubmittedIds(['a'], ['a'])).toEqual([]);
    expect(clearSubmittedIds(['b'], ['a'])).toEqual(['b']);
    expect(clearSubmittedIds([], ['a'])).toEqual([]);
  });

  it('hides a batch action that would be a no-op for the whole selection', () => {
    expect(bulkActionAvailable([], 'resolve')).toBe(false);
    expect(bulkActionAvailable(['resolved', 'resolved'], 'resolve')).toBe(false);
    expect(bulkActionAvailable(['resolved', 'open'], 'resolve')).toBe(true);
    expect(bulkActionAvailable(['open'], 'reopen')).toBe(false);
    expect(bulkActionAvailable(['ignored'], 'reopen')).toBe(true);
  });

  it('reads the statuses of selected rows only', () => {
    const rows = [issue('a', 'open'), issue('b', 'resolved'), issue('c', 'ignored')];
    expect(selectedStatuses(rows, ['a', 'c', 'gone'])).toEqual(['open', 'ignored']);
  });

  it('removes batch-updated rows that left the active status tab', () => {
    const rows = [issue('a', 'open'), issue('b', 'open'), issue('c', 'open')];
    const merged = applyBulkUpdateToList(
      rows,
      [
        { id: 'a', status: 'resolved' as LogIssueStatus },
        { id: 'c', status: 'resolved' as LogIssueStatus },
      ],
      'open',
    );
    expect(merged.map((r) => r.id)).toEqual(['b']);
  });

  it('keeps batch-updated rows in place on the All tab', () => {
    const rows = [issue('a', 'open'), issue('b', 'open')];
    const merged = applyBulkUpdateToList(rows, [{ id: 'a', status: 'ignored' }], '');
    expect(merged).toEqual([issue('a', 'ignored'), issue('b', 'open')]);
  });

  it('returns the list unchanged when nothing was updated', () => {
    const rows = [issue('a', 'open')];
    expect(applyBulkUpdateToList(rows, [], 'open')).toEqual(rows);
  });

  it('summarises a batch result including stale ids', () => {
    expect(bulkResultMessage('resolve', 1)).toBe('1 issue resolved');
    expect(bulkResultMessage('ignore', 3)).toBe('3 issues ignored');
    expect(bulkResultMessage('reopen', 2)).toBe('2 issues reopened');
    expect(bulkResultMessage('resolve', 2, 1)).toBe('2 issues resolved · 1 no longer available');
  });
});
