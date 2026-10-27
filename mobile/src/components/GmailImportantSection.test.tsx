import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const { default: TestRenderer, act } = await import('react-test-renderer');

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Switch: 'Switch',
  TouchableOpacity: 'TouchableOpacity',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../theme/colors', () => ({ colors: {} }));
vi.mock('./AppIcon', () => ({ default: 'AppIcon' }));
vi.mock('../utils/api', () => ({
  api: {
    getGmailImportance: vi.fn(),
    updateGmailImportanceSettings: vi.fn(),
    startGmailImportanceScan: vi.fn(),
    dismissGmailImportantThread: vi.fn(),
  },
}));

const { api } = await import('../utils/api');
const { default: GmailImportantSection } = await import('./GmailImportantSection');

function state(settings: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    running: false,
    threads: [],
    settings: {
      enabled: false,
      windowDays: 7,
      autoScan: 'off',
      lastScanAt: null,
      lastScanStatus: 'idle',
      lastScanError: null,
      lastScanEngine: null,
      lastScanModel: null,
      lastScanFailover: null,
      ...settings,
    },
    ...extra,
  };
}

function text(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

describe('mobile GmailImportantSection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.mocked(api.getGmailImportance).mockReset();
    vi.mocked(api.updateGmailImportanceSettings).mockReset();
    vi.mocked(api.startGmailImportanceScan).mockReset();
    vi.mocked(api.dismissGmailImportantThread).mockReset();
  });

  it('turning the toggle on saves the setting and starts a first scan', async () => {
    vi.mocked(api.getGmailImportance).mockResolvedValue(state());
    vi.mocked(api.updateGmailImportanceSettings).mockResolvedValue(state({ enabled: true }));
    vi.mocked(api.startGmailImportanceScan).mockResolvedValue(
      state({ enabled: true }, { running: true }),
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<GmailImportantSection onOpenThread={vi.fn()} />);
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'gmail-important-toggle' }).props.onValueChange(true);
    });
    expect(api.updateGmailImportanceSettings).toHaveBeenCalledWith({ enabled: true }, {});
    expect(api.startGmailImportanceScan).toHaveBeenCalledWith({ windowDays: 7 }, {});
    expect(text(renderer)).toContain('Scanning your inbox');
    renderer.unmount();
  });

  it('keeps polling after a failed poll until the scan finishes', async () => {
    vi.useFakeTimers();
    vi.mocked(api.getGmailImportance)
      .mockResolvedValueOnce(state({ enabled: true }, { running: true }))
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce(
        state({ enabled: true, lastScanStatus: 'ok', lastScanAt: new Date().toISOString() }),
      );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<GmailImportantSection onOpenThread={vi.fn()} />);
    });
    expect(text(renderer)).toContain('Scanning your inbox');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(api.getGmailImportance).toHaveBeenCalledTimes(3);
    expect(text(renderer)).toContain('Scanned');
    expect(renderer.root.findByProps({ testID: 'gmail-important-scan' }).props.disabled).toBe(
      false,
    );
    renderer.unmount();
  });

  it('picks up an automated scan that starts after an idle load', async () => {
    vi.useFakeTimers();
    vi.mocked(api.getGmailImportance)
      .mockResolvedValueOnce(
        state({ enabled: true, lastScanStatus: 'ok', lastScanAt: new Date().toISOString() }),
      )
      .mockResolvedValueOnce(state({ enabled: true }, { running: true }))
      .mockResolvedValueOnce(
        state(
          { enabled: true, lastScanStatus: 'ok', lastScanAt: new Date().toISOString() },
          {
            threads: [
              {
                threadId: 't5',
                historyId: '1',
                important: true,
                score: 70,
                reason: 'Invoice overdue',
                subject: 'Invoice',
                from: 'Billing <billing@example.com>',
                snippet: null,
                lastMessageAt: '2026-10-12T10:00:00.000Z',
                scannedAt: '2026-10-12T11:00:00.000Z',
              },
            ],
          },
        ),
      );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<GmailImportantSection onOpenThread={vi.fn()} />);
    });
    expect(text(renderer)).toContain('Scanned');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(text(renderer)).toContain('Scanning your inbox');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(text(renderer)).toContain('Invoice overdue');
    renderer.unmount();
  });

  it('locks the chips when the server refuses a window change for a scan it started', async () => {
    vi.mocked(api.getGmailImportance)
      .mockResolvedValueOnce(state({ enabled: true, windowDays: 1, lastScanStatus: 'ok' }))
      .mockResolvedValue(state({ enabled: true, windowDays: 1 }, { running: true }));
    vi.mocked(api.updateGmailImportanceSettings).mockRejectedValueOnce(
      Object.assign(new Error('A scan is running. Change the window when it finishes.'), {
        status: 409,
      }),
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<GmailImportantSection onOpenThread={vi.fn()} />);
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'gmail-important-window-30' }).props.onPress();
    });
    expect(text(renderer)).toContain('Change the window when it finishes');
    expect(text(renderer)).toContain('Scanning your inbox');
    expect(renderer.root.findByProps({ testID: 'gmail-important-window-30' }).props.disabled).toBe(
      true,
    );
    expect(api.startGmailImportanceScan).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('explains why the toggle stayed off when enabling fails', async () => {
    vi.mocked(api.getGmailImportance).mockResolvedValue(state());
    vi.mocked(api.updateGmailImportanceSettings).mockRejectedValueOnce(
      new Error('Server unavailable'),
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<GmailImportantSection onOpenThread={vi.fn()} />);
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'gmail-important-toggle' }).props.onValueChange(true);
    });
    expect(renderer.root.findByProps({ testID: 'gmail-important-error' }).props.children).toBe(
      'Server unavailable',
    );
    expect(renderer.root.findByProps({ testID: 'gmail-important-toggle' }).props.value).toBe(false);
    expect(api.startGmailImportanceScan).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('shows the error when the first load fails', async () => {
    vi.mocked(api.getGmailImportance).mockRejectedValueOnce(new Error('Failed to fetch'));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<GmailImportantSection onOpenThread={vi.fn()} />);
    });
    expect(renderer.root.findByProps({ testID: 'gmail-important-error' }).props.children).toBe(
      'Failed to fetch',
    );
    renderer.unmount();
  });

  it('releases its pins on unmount and reports none after a failed remount load', async () => {
    const pin = {
      threadId: 't9',
      historyId: '1',
      important: true,
      score: 80,
      reason: 'Contract deadline',
      subject: 'Renewal',
      from: 'Dana <dana@example.com>',
      snippet: null,
      lastMessageAt: '2026-10-12T10:00:00.000Z',
      scannedAt: '2026-10-12T11:00:00.000Z',
    };
    vi.mocked(api.getGmailImportance)
      .mockResolvedValueOnce(
        state(
          { enabled: true, lastScanStatus: 'ok', lastScanAt: '2026-10-12T11:00:00.000Z' },
          { threads: [pin] },
        ),
      )
      .mockRejectedValueOnce(new Error('Failed to fetch'));
    const onPinnedChange = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <GmailImportantSection onOpenThread={vi.fn()} onPinnedChange={onPinnedChange} />,
      );
    });
    expect(onPinnedChange).toHaveBeenLastCalledWith([pin]);

    await act(async () => {
      renderer.unmount();
    });
    expect(onPinnedChange).toHaveBeenLastCalledWith([]);

    onPinnedChange.mockClear();
    await act(async () => {
      renderer = TestRenderer.create(
        <GmailImportantSection onOpenThread={vi.fn()} onPinnedChange={onPinnedChange} />,
      );
    });
    expect(renderer.root.findByProps({ testID: 'gmail-important-error' }).props.children).toBe(
      'Failed to fetch',
    );
    expect(onPinnedChange.mock.calls.every(([pins]) => pins.length === 0)).toBe(true);
    renderer.unmount();
  });

  it('removes a pinned thread and hands it back to the regular list', async () => {
    const pin = {
      threadId: 't9',
      historyId: '1',
      important: true,
      score: 80,
      reason: 'Contract deadline',
      subject: 'Renewal',
      from: 'Dana <dana@example.com>',
      snippet: null,
      lastMessageAt: '2026-10-12T10:00:00.000Z',
      scannedAt: '2026-10-12T11:00:00.000Z',
    };
    const on = { enabled: true, lastScanStatus: 'ok', lastScanAt: '2026-10-12T11:00:00.000Z' };
    vi.mocked(api.getGmailImportance).mockResolvedValue(state(on, { threads: [pin] }));
    vi.mocked(api.dismissGmailImportantThread).mockResolvedValue(state(on, { threads: [] }));
    const onPinnedChange = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <GmailImportantSection onOpenThread={vi.fn()} onPinnedChange={onPinnedChange} />,
      );
    });
    expect(onPinnedChange).toHaveBeenLastCalledWith([pin]);
    await act(async () => {
      renderer.root.findByProps({ testID: 'gmail-important-dismiss-t9' }).props.onPress();
    });
    expect(api.dismissGmailImportantThread).toHaveBeenCalledWith('t9', {});
    expect(renderer.root.findAllByProps({ testID: 'gmail-important-thread-t9' })).toHaveLength(0);
    expect(onPinnedChange).toHaveBeenLastCalledWith([]);
    renderer.unmount();
  });

  it('locks the window chips while a scan is running', async () => {
    vi.mocked(api.getGmailImportance).mockResolvedValue(
      state({ enabled: true, windowDays: 1 }, { running: true }),
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<GmailImportantSection onOpenThread={vi.fn()} />);
    });
    const chip = renderer.root.findByProps({ testID: 'gmail-important-window-30' });
    expect(chip.props.disabled).toBe(true);
    await act(async () => {
      chip.props.onPress();
    });
    expect(api.updateGmailImportanceSettings).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('lists pinned threads, opens one, and saves window and auto-scan picks', async () => {
    const onOpenThread = vi.fn();
    const enabled = state(
      { enabled: true, lastScanAt: '2026-10-12T11:00:00.000Z', lastScanStatus: 'ok' },
      {
        threads: [
          {
            threadId: 't9',
            historyId: '1',
            important: true,
            score: 80,
            reason: 'Contract deadline',
            subject: 'Renewal',
            from: '"Dana" <dana@example.com>',
            snippet: null,
            lastMessageAt: '2026-10-12T10:00:00.000Z',
            scannedAt: '2026-10-12T11:00:00.000Z',
          },
        ],
      },
    );
    vi.mocked(api.getGmailImportance).mockResolvedValue(enabled);
    vi.mocked(api.updateGmailImportanceSettings).mockResolvedValue(enabled);
    vi.mocked(api.startGmailImportanceScan).mockResolvedValue(enabled);
    const onPinnedChange = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <GmailImportantSection onOpenThread={onOpenThread} onPinnedChange={onPinnedChange} />,
      );
    });
    expect(text(renderer)).toContain('Contract deadline');
    expect(onPinnedChange).toHaveBeenCalledWith(enabled.threads);

    const row = renderer.root.findByProps({ testID: 'gmail-important-thread-t9' });
    await act(async () => {
      row.props.onPress();
    });
    expect(onOpenThread).toHaveBeenCalledWith('t9');

    await act(async () => {
      renderer.root.findByProps({ testID: 'gmail-important-window-30' }).props.onPress();
    });
    expect(api.updateGmailImportanceSettings).toHaveBeenCalledWith({ windowDays: 30 }, {});

    await act(async () => {
      renderer.root.findByProps({ testID: 'gmail-important-auto-daily' }).props.onPress();
    });
    expect(api.updateGmailImportanceSettings).toHaveBeenCalledWith({ autoScan: 'daily' }, {});
    renderer.unmount();
  });
});
