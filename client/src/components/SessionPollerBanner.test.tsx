import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';

(vi as any).mock('../utils/api', () => ({
  api: {
    listSessionPollers: vi.fn(),
    stopSessionPoller: vi.fn(),
  },
}));

import { api } from '../utils/api';
import SessionPollerBanner from './SessionPollerBanner';
import { SESSION_POLLER_WS_EVENT } from '../utils/sessionPollers';

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

function poller(id: string, over: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id,
    sessionId: 's1',
    pollerId: `p-${id}`,
    task: 'Check dev intake and forward any issues.',
    intervalMinutes: 30,
    durationMinutes: 240,
    notifyEachRun: false,
    notifyOnComplete: true,
    status: 'active',
    runCount: 1,
    startedAt: new Date(now).toISOString(),
    endsAt: new Date(now + 240 * 60_000).toISOString(),
    nextRunAt: new Date(now + 30 * 60_000).toISOString(),
    lastRunAt: new Date(now).toISOString(),
    finishedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => cleanup());

describe('SessionPollerBanner', () => {
  it('renders nothing when no poller is running', async () => {
    mocked.listSessionPollers.mockResolvedValue({
      pollers: [poller('a', { status: 'completed' })],
    });
    render(<SessionPollerBanner sessionId="s1" />);
    await waitFor(() => expect(mocked.listSessionPollers).toHaveBeenCalledWith('s1'));
    expect(screen.queryByTestId('session-poller-banner')).toBeNull();
  });

  it('shows a running poller with its schedule and cancels it', async () => {
    mocked.listSessionPollers.mockResolvedValue({ pollers: [poller('a')] });
    mocked.stopSessionPoller.mockResolvedValue({ poller: poller('a', { status: 'cancelled' }) });
    render(<SessionPollerBanner sessionId="s1" />);
    expect(await screen.findByText(/Check dev intake/)).toBeTruthy();
    expect(screen.getByText(/Every 30 min · 1 run so far/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(mocked.stopSessionPoller).toHaveBeenCalledWith('s1', 'a'));
    await waitFor(() => expect(screen.queryByTestId('session-poller-banner')).toBeNull());
  });

  it('appears when a poller starts and hides when a push says it finished', async () => {
    mocked.listSessionPollers.mockResolvedValue({ pollers: [] });
    render(<SessionPollerBanner sessionId="s1" />);
    await waitFor(() => expect(mocked.listSessionPollers).toHaveBeenCalled());

    const emit = (detail: Record<string, unknown>) =>
      act(() => {
        window.dispatchEvent(new CustomEvent(SESSION_POLLER_WS_EVENT, { detail }));
      });

    emit({ sessionId: 'other', poller: poller('x', { sessionId: 'other' }) });
    expect(screen.queryByTestId('session-poller-banner')).toBeNull();

    emit({ sessionId: 's1', poller: poller('a') });
    expect(await screen.findByTestId('session-poller-banner')).toBeTruthy();

    emit({ sessionId: 's1', poller: poller('a', { status: 'completed' }) });
    await waitFor(() => expect(screen.queryByTestId('session-poller-banner')).toBeNull());
  });

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const push = (detail: Record<string, unknown>) =>
    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_POLLER_WS_EVENT, { detail }));
    });

  it('keeps a push that lands before the initial list resolves', async () => {
    const pending = deferred<{ pollers: unknown[] }>();
    mocked.listSessionPollers.mockReturnValue(pending.promise);
    render(<SessionPollerBanner sessionId="s1" />);

    push({ sessionId: 's1', poller: poller('a') });
    expect(await screen.findByTestId('session-poller-banner')).toBeTruthy();

    // The snapshot was taken before the poller started.
    await act(async () => pending.resolve({ pollers: [] }));
    expect(screen.getByTestId('session-poller-banner')).toBeTruthy();
  });

  it('a stale refresh does not overwrite a newer push', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocked.listSessionPollers.mockResolvedValueOnce({ pollers: [poller('a')] });
      render(<SessionPollerBanner sessionId="s1" />);
      expect(await screen.findByTestId('session-poller-banner')).toBeTruthy();

      const pending = deferred<{ pollers: unknown[] }>();
      mocked.listSessionPollers.mockReturnValue(pending.promise);
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      // A second poller starts while the refresh is in flight.
      push({ sessionId: 's1', poller: poller('b', { task: 'Second check' }) });
      await act(async () => pending.resolve({ pollers: [poller('a')] }));
      expect(screen.getByText(/Second check/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a running poller visible when a refresh fails, then recovers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocked.listSessionPollers.mockResolvedValueOnce({ pollers: [poller('a')] });
      render(<SessionPollerBanner sessionId="s1" />);
      expect(await screen.findByTestId('session-poller-banner')).toBeTruthy();

      mocked.listSessionPollers.mockRejectedValueOnce(new Error('offline'));
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      expect(screen.getByTestId('session-poller-banner')).toBeTruthy();
      expect(screen.getByRole('button', { name: /Cancel/ })).toBeTruthy();

      mocked.listSessionPollers.mockResolvedValueOnce({
        pollers: [poller('a', { runCount: 3 })],
      });
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      expect(mocked.listSessionPollers).toHaveBeenCalledTimes(3);
      expect(screen.getByText(/3 runs so far/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries after a failed first read and finds a running poller', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocked.listSessionPollers.mockRejectedValueOnce(new Error('offline'));
      render(<SessionPollerBanner sessionId="s1" />);
      await act(async () => {});
      expect(screen.queryByTestId('session-poller-banner')).toBeNull();

      mocked.listSessionPollers.mockResolvedValue({ pollers: [poller('a')] });
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      expect(await screen.findByTestId('session-poller-banner')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a refresh in flight during Cancel does not bring the poller back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocked.listSessionPollers.mockResolvedValueOnce({ pollers: [poller('a')] });
      render(<SessionPollerBanner sessionId="s1" />);
      expect(await screen.findByTestId('session-poller-banner')).toBeTruthy();

      const pending = deferred<{ pollers: unknown[] }>();
      mocked.listSessionPollers.mockReturnValue(pending.promise);
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      mocked.stopSessionPoller.mockResolvedValue({ poller: poller('a', { status: 'cancelled' }) });
      fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
      await waitFor(() => expect(screen.queryByTestId('session-poller-banner')).toBeNull());

      await act(async () => pending.resolve({ pollers: [poller('a')] }));
      expect(screen.queryByTestId('session-poller-banner')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
