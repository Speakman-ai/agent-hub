import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  StyleSheet: { create: (s: any) => s },
  View: 'View',
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
}));
vi.mock('../theme/colors', () => ({ colors: new Proxy({}, { get: () => '#000' }) }));
const listSessionPollers = vi.fn();
const stopSessionPoller = vi.fn();
vi.mock('../utils/api', () => ({ api: { listSessionPollers, stopSessionPoller } }));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { default: SessionPollerBanner } = await import('./SessionPollerBanner');
process.env.NODE_ENV = originalNodeEnv;
const act = TestRenderer.act;

const active = {
  id: 'p-1',
  sessionId: 's-1',
  pollerId: 'dev-tickets',
  task: 'Check dev for new tickets',
  intervalMinutes: 30,
  durationMinutes: 240,
  notifyEachRun: false,
  notifyOnComplete: true,
  status: 'active',
  runCount: 2,
  startedAt: '2026-11-10T14:20:00.000Z',
  endsAt: '2026-11-10T18:20:00.000Z',
  nextRunAt: '2026-11-10T15:20:00.000Z',
  lastRunAt: null,
  finishedAt: null,
};

const flush = () => act(async () => {});

describe('SessionPollerBanner (mobile)', () => {
  beforeEach(() => {
    listSessionPollers.mockReset();
    stopSessionPoller.mockReset();
  });

  it('renders nothing without a running poller', async () => {
    listSessionPollers.mockResolvedValue({ pollers: [{ ...active, status: 'completed' }] });
    let r: any;
    await act(async () => {
      r = TestRenderer.create(React.createElement(SessionPollerBanner, { sessionId: 's-1' }));
    });
    await flush();
    expect(r.toJSON()).toBeNull();
  });

  it('shows the running poller and cancels it', async () => {
    listSessionPollers.mockResolvedValue({ pollers: [active] });
    stopSessionPoller.mockResolvedValue({ poller: { ...active, status: 'cancelled' } });
    let r: any;
    await act(async () => {
      r = TestRenderer.create(React.createElement(SessionPollerBanner, { sessionId: 's-1' }));
    });
    await flush();
    expect(r.root.findByProps({ testID: 'session-poller-banner' })).toBeTruthy();
    const cancel = r.root.findByProps({ accessibilityLabel: 'Cancel poller' });
    await act(async () => {
      cancel.props.onPress();
    });
    await flush();
    expect(stopSessionPoller).toHaveBeenCalledWith('s-1', 'p-1');
    expect(r.toJSON()).toBeNull();
  });

  it('a refresh in flight during Cancel does not bring the poller back', async () => {
    vi.useFakeTimers();
    try {
      listSessionPollers.mockResolvedValueOnce({ pollers: [active] });
      let r: any;
      await act(async () => {
        r = TestRenderer.create(React.createElement(SessionPollerBanner, { sessionId: 's-1' }));
      });
      await flush();
      expect(r.toJSON()).not.toBeNull();

      let resolveList!: (v: unknown) => void;
      listSessionPollers.mockReturnValue(new Promise((res) => (resolveList = res)));
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      stopSessionPoller.mockResolvedValue({ poller: { ...active, status: 'cancelled' } });
      await act(async () => {
        r.root.findByProps({ accessibilityLabel: 'Cancel poller' }).props.onPress();
      });
      await flush();
      expect(r.toJSON()).toBeNull();

      await act(async () => resolveList({ pollers: [active] }));
      expect(r.toJSON()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries after a failed first read', async () => {
    vi.useFakeTimers();
    try {
      listSessionPollers.mockRejectedValueOnce(new Error('offline'));
      let r: any;
      await act(async () => {
        r = TestRenderer.create(React.createElement(SessionPollerBanner, { sessionId: 's-1' }));
      });
      await flush();
      expect(r.toJSON()).toBeNull();
      listSessionPollers.mockResolvedValue({ pollers: [active] });
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      await flush();
      expect(r.toJSON()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
