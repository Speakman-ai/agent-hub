import type { ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const appStateListeners: Array<(state: string) => void> = [];
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_type: string, fn: (state: string) => void) => {
      appStateListeners.push(fn);
      return {
        remove: () => appStateListeners.splice(appStateListeners.indexOf(fn), 1),
      };
    },
  },
  StyleSheet: { create: (s: any) => s },
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  Switch: 'Switch',
}));
vi.mock('../theme/colors', () => ({ colors: new Proxy({}, { get: () => '#000' }) }));
const listSessionPollers = vi.fn();
const startSessionPoller = vi.fn();
const stopSessionPoller = vi.fn();
vi.mock('../utils/api', () => ({
  api: { listSessionPollers, startSessionPoller, stopSessionPoller },
}));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { default: SessionPollerCard } = await import('./SessionPollerCard');
process.env.NODE_ENV = originalNodeEnv;
const act = TestRenderer.act;

const proposal = {
  pollerId: 'dev-tickets',
  task: 'Check dev for new tickets',
  intervalMinutes: 30,
  durationMinutes: null,
  until: 'tomorrow 09:00',
  notifyEachRun: false,
  notifyOnComplete: true,
};

const active = {
  id: 'p-1',
  sessionId: 's-1',
  pollerId: 'dev-tickets',
  task: 'Check dev for new tickets',
  intervalMinutes: 30,
  durationMinutes: 1120,
  notifyEachRun: false,
  notifyOnComplete: true,
  status: 'active',
  runCount: 2,
  startedAt: '2026-11-10T14:20:00.000Z',
  endsAt: '2026-11-11T09:00:00.000Z',
  nextRunAt: '2026-11-10T15:20:00.000Z',
  lastRunAt: null,
  finishedAt: null,
};

function texts(r: ReactTestRenderer): string[] {
  return r.root
    .findAllByType('Text' as any)
    .map((n) => [n.props.children].flat().join(''))
    .filter(Boolean);
}

function button(r: ReactTestRenderer, label: string) {
  return r.root
    .findAllByType('TouchableOpacity' as any)
    .find((n) => texts({ root: n } as unknown as ReactTestRenderer).includes(label))!;
}

describe('SessionPollerCard (mobile)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 10, 14, 20));
    listSessionPollers.mockReset();
    startSessionPoller.mockReset();
    stopSessionPoller.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('picks up a poller started on another device while showing the form', async () => {
    listSessionPollers.mockResolvedValueOnce({ pollers: [] });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(<SessionPollerCard sessionId="s-1" proposal={proposal} />);
    });
    expect(texts(r)).toContain('Set up a poller');

    listSessionPollers.mockResolvedValue({ pollers: [active] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(texts(r)).toContain('Running · 2 runs so far');
    expect(texts(r)).toContain('Stop');
    r.unmount();
  });

  it('stops refetching once the poller is finished', async () => {
    listSessionPollers.mockResolvedValue({ pollers: [{ ...active, status: 'completed' }] });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(<SessionPollerCard sessionId="s-1" proposal={proposal} />);
    });
    expect(texts(r)).toContain('Finished after 2 runs');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(listSessionPollers).toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it('anchors "tomorrow" to the proposal when reopened after midnight', async () => {
    listSessionPollers.mockResolvedValue({ pollers: [] });
    startSessionPoller.mockResolvedValue({ poller: active, created: true });
    vi.setSystemTime(new Date(2026, 10, 11, 1, 0));
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(
        <SessionPollerCard
          sessionId="s-1"
          proposal={proposal}
          proposedAt={new Date(2026, 10, 10, 14, 20).toISOString()}
        />,
      );
    });
    await act(async () => {
      await button(r, 'Start').props.onPress();
    });
    expect(startSessionPoller.mock.calls[0][1].durationMinutes).toBe(480);
    r.unmount();
  });

  it('asks for a duration when reopened after the requested end time', async () => {
    listSessionPollers.mockResolvedValue({ pollers: [] });
    vi.setSystemTime(new Date(2026, 10, 11, 10, 0));
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(
        <SessionPollerCard
          sessionId="s-1"
          proposal={proposal}
          proposedAt={new Date(2026, 10, 10, 14, 20).toISOString()}
        />,
      );
    });
    expect(texts(r).some((t) => /The requested end .* has passed/.test(t))).toBe(true);
    expect(button(r, 'Start').props.disabled).toBe(true);
    r.unmount();
  });

  it('re-reads when the app returns to the foreground', async () => {
    listSessionPollers.mockResolvedValueOnce({ pollers: [active] });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(<SessionPollerCard sessionId="s-1" proposal={proposal} />);
    });
    expect(texts(r)).toContain('Running · 2 runs so far');
    listSessionPollers.mockResolvedValue({
      pollers: [{ ...active, status: 'completed', runCount: 38 }],
    });
    await act(async () => {
      appStateListeners.forEach((fn) => fn('active'));
    });
    expect(texts(r)).toContain('Finished after 38 runs');
    r.unmount();
  });

  it('keeps the named end time when Start is pressed later', async () => {
    listSessionPollers.mockResolvedValue({ pollers: [] });
    startSessionPoller.mockResolvedValue({ poller: active, created: true });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(<SessionPollerCard sessionId="s-1" proposal={proposal} />);
    });
    vi.setSystemTime(new Date(2026, 10, 10, 15, 20));
    await act(async () => {
      await button(r, 'Start').props.onPress();
    });
    expect(startSessionPoller.mock.calls[0][1].durationMinutes).toBe(1060);
    r.unmount();
  });
});
