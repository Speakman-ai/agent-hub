import { describe, expect, it, vi } from 'vitest';

// Same host-tag RN mock as LogsScreen.clearLogs.test.tsx: the mobile test env
// has no native runtime, so batch triage is exercised through the extracted
// `runBulkIssueStatus` seam rather than a rendered tap.
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  FlatList: 'FlatList',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../components/ProjectScreenHeader', () => ({ default: 'ProjectScreenHeader' }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({}) }));
vi.mock('./LogSourcesScreen', () => ({ LogSourcesPanel: 'LogSourcesPanel' }));
vi.mock('../hooks/useLogTail', () => ({ useLogTail: () => ({ records: [] }) }));
vi.mock('../utils/api', () => ({
  api: { clearLogs: vi.fn(), queryLogs: vi.fn(), bulkSetLogIssueStatus: vi.fn() },
}));

import { runBulkIssueStatus } from './LogsScreen';
import { clearSubmittedIds, toggleSelectedId } from '@shared/utils/logIssueSelection';

describe('runBulkIssueStatus', () => {
  it('posts the mapped status and toasts the applied count', async () => {
    const bulkSetStatus = vi.fn().mockResolvedValue({
      updated: [
        { id: 'a', status: 'resolved' },
        { id: 'b', status: 'resolved' },
      ],
      notFound: [],
    });
    const showToast = vi.fn();

    const result = await runBulkIssueStatus({
      projectId: 'p1',
      issueIds: ['a', 'b'],
      action: 'resolve',
      bulkSetStatus,
      showToast,
    });

    expect(bulkSetStatus).toHaveBeenCalledWith('p1', ['a', 'b'], 'resolved');
    expect(result?.updated).toHaveLength(2);
    expect(showToast).toHaveBeenCalledWith('2 issues resolved', 'success');
  });

  it('reports ids that were no longer available', async () => {
    const showToast = vi.fn();
    const result = await runBulkIssueStatus({
      projectId: 'p1',
      issueIds: ['a', 'gone'],
      action: 'ignore',
      bulkSetStatus: vi
        .fn()
        .mockResolvedValue({ updated: [{ id: 'a', status: 'ignored' }], notFound: ['gone'] }),
      showToast,
    });

    expect(result?.notFound).toEqual(['gone']);
    expect(showToast).toHaveBeenCalledWith('1 issue ignored · 1 no longer available', 'success');
  });

  it('returns null and surfaces the error when the batch fails', async () => {
    const showToast = vi.fn();
    const result = await runBulkIssueStatus({
      projectId: 'p1',
      issueIds: ['a'],
      action: 'reopen',
      bulkSetStatus: vi.fn().mockRejectedValue(new Error('500: boom')),
      showToast,
    });

    expect(result).toBeNull();
    expect(showToast).toHaveBeenCalledWith('500: boom', 'error');
  });

  it('leaves a row ticked mid-request selected after the batch completes', async () => {
    // Regression: the screen used to reset the whole selection on completion,
    // silently dropping rows ticked while the request was in flight. Rows stay
    // tappable during a batch, so this reproduces that ordering: freeze the
    // submitted ids, tick another row mid-flight, then clear only what was sent.
    let selection = ['a'];
    const submitted = selection;
    const result = await runBulkIssueStatus({
      projectId: 'p1',
      issueIds: submitted,
      action: 'resolve',
      bulkSetStatus: vi.fn().mockImplementation(async (_p: string, ids: string[]) => {
        selection = toggleSelectedId(selection, 'b'); // user taps another row
        return { updated: ids.map((id) => ({ id, status: 'resolved' })), notFound: [] };
      }),
    });
    selection = clearSubmittedIds(selection, submitted);

    expect(submitted).toEqual(['a']);
    expect(result?.updated).toEqual([{ id: 'a', status: 'resolved' }]);
    expect(selection).toEqual(['b']);
  });

  it('tolerates a malformed response body without throwing', async () => {
    const showToast = vi.fn();
    const result = await runBulkIssueStatus({
      projectId: 'p1',
      issueIds: ['a'],
      action: 'resolve',
      bulkSetStatus: vi.fn().mockResolvedValue(undefined),
      showToast,
    });

    expect(result).toEqual({ updated: [], notFound: [] });
    expect(showToast).toHaveBeenCalledWith('0 issues resolved', 'success');
  });
});
