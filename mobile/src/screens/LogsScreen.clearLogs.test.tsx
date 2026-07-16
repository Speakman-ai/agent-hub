import { describe, expect, it, vi } from 'vitest';

// RN primitives + native-only deps are mocked as host string tags / no-ops so
// the module imports cleanly under the `node` test env (no native runtime),
// matching the LogSourcesScreen.test.tsx pattern. The mobile test env has no RN
// event dispatch, so the destructive clear wiring is exercised through the
// extracted `runLogClear` / `buildClearConfirm` seams rather than a rendered tap.
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
vi.mock('../utils/api', () => ({ api: { clearLogs: vi.fn(), queryLogs: vi.fn() } }));

import { clearedLogsMessage, runLogClear, buildClearConfirm } from './LogsScreen';

describe('clearedLogsMessage', () => {
  it('reports a plural count', () => {
    expect(clearedLogsMessage(2)).toBe('Cleared 2 logs.');
  });

  it('uses the singular form for exactly one record', () => {
    expect(clearedLogsMessage(1)).toBe('Cleared 1 log.');
  });

  it('thousands-separates large counts', () => {
    expect(clearedLogsMessage(12345)).toBe('Cleared 12,345 logs.');
  });

  it('reports nothing-to-clear for zero / negative / non-finite input', () => {
    expect(clearedLogsMessage(0)).toBe('No logs to clear.');
    expect(clearedLogsMessage(-5)).toBe('No logs to clear.');
    expect(clearedLogsMessage(Number.NaN)).toBe('No logs to clear.');
  });
});

describe('runLogClear', () => {
  function deps(over: Partial<Parameters<typeof runLogClear>[0]> = {}) {
    return {
      projectId: 'p1',
      clearLogs: vi.fn().mockResolvedValue({ purged: 3 }),
      reset: vi.fn(),
      clearHistory: vi.fn(),
      showToast: vi.fn(),
      ...over,
    };
  }

  it('purges, resets the tail + history, and toasts the count on success', async () => {
    const d = deps();
    await runLogClear(d);
    expect(d.clearLogs).toHaveBeenCalledWith('p1');
    expect(d.reset).toHaveBeenCalledTimes(1);
    expect(d.clearHistory).toHaveBeenCalledTimes(1);
    expect(d.showToast).toHaveBeenCalledWith('Cleared 3 logs.', 'success');
  });

  it('toasts the nothing-to-clear message when zero records were purged', async () => {
    const d = deps({ clearLogs: vi.fn().mockResolvedValue({ purged: 0 }) });
    await runLogClear(d);
    expect(d.reset).toHaveBeenCalledTimes(1);
    expect(d.showToast).toHaveBeenCalledWith('No logs to clear.', 'success');
  });

  it('surfaces an error and does NOT blank the view when the purge fails', async () => {
    const d = deps({ clearLogs: vi.fn().mockRejectedValue(new Error('nope')) });
    await runLogClear(d);
    expect(d.reset).not.toHaveBeenCalled();
    expect(d.clearHistory).not.toHaveBeenCalled();
    expect(d.showToast).toHaveBeenCalledWith('nope', 'error');
  });
});

describe('buildClearConfirm', () => {
  it('offers a destructive Clear action that runs the confirm callback', () => {
    const onConfirm = vi.fn();
    const { title, buttons } = buildClearConfirm(onConfirm);
    expect(title).toBe('Clear all logs?');

    const clear = buttons.find((b) => b.style === 'destructive');
    expect(clear?.text).toBe('Clear logs');
    clear?.onPress?.();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('offers a passive Cancel that triggers no action', () => {
    const onConfirm = vi.fn();
    const { buttons } = buildClearConfirm(onConfirm);
    const cancel = buttons.find((b) => b.style === 'cancel');
    expect(cancel?.text).toBe('Cancel');
    expect(cancel?.onPress).toBeUndefined();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
