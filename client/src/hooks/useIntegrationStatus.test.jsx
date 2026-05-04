import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useIntegrationStatus } from './useIntegrationStatus.js';

function Harness({ params, capture }) {
  const result = useIntegrationStatus(params);
  capture(result);
  return null;
}

function renderHook(params, capture) {
  return render(<Harness params={params} capture={capture} />);
}

// Flush pending promise microtasks without advancing the timer clock.
// `vi.runOnlyPendingTimersAsync` would also fire any in-flight intervals,
// which we don't want when asserting "exactly N initial calls".
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useIntegrationStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs an initial fetch and reports loading → data', async () => {
    const fetcher = vi.fn().mockResolvedValue({ app: 'slack', status: 'PENDING' });
    let snapshot = null;
    renderHook({ userId: 'u1', app: 'slack', polling: false, fetcher }, (r) => (snapshot = r));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(snapshot.loading).toBe(true);

    await flushMicrotasks();
    expect(snapshot.data).toEqual({ app: 'slack', status: 'PENDING' });
    expect(snapshot.loading).toBe(false);
    expect(snapshot.error).toBeNull();
  });

  it('does not start the poll interval while polling=false', async () => {
    const fetcher = vi.fn().mockResolvedValue({ app: 'slack', status: 'PENDING' });
    renderHook({ userId: 'u1', app: 'slack', polling: false, fetcher }, () => {});
    await flushMicrotasks();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Advance well beyond a poll interval — fetcher must not be called again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('polls every pollIntervalMs while polling=true and stops when CONNECTED', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ app: 'slack', status: 'PENDING' })
      .mockResolvedValueOnce({ app: 'slack', status: 'PENDING' })
      .mockResolvedValueOnce({ app: 'slack', status: 'CONNECTED' });

    let snapshot = null;
    const onConnected = vi.fn();
    renderHook(
      {
        userId: 'u1',
        app: 'slack',
        polling: true,
        fetcher,
        pollIntervalMs: 2000,
        onConnected,
      },
      (r) => (snapshot = r),
    );

    // Initial fetch
    await flushMicrotasks();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // First poll tick: still PENDING
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Second poll tick: CONNECTED → interval clears, callback fires
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(snapshot.data?.status).toBe('CONNECTED');

    // Further ticks must NOT re-fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('fires onTimeout and stops polling once pollTimeoutMs elapses', async () => {
    const fetcher = vi.fn().mockResolvedValue({ app: 'slack', status: 'PENDING' });
    let snapshot = null;
    const onTimeout = vi.fn();

    renderHook(
      {
        userId: 'u1',
        app: 'slack',
        polling: true,
        fetcher,
        pollIntervalMs: 1000,
        pollTimeoutMs: 3000,
        onTimeout,
      },
      (r) => (snapshot = r),
    );

    // Initial fetch
    await flushMicrotasks();

    // Three poll ticks of 1s — on the tick AFTER 3000ms elapses, the
    // hook detects timeout, clears the interval, and skips the fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(snapshot.timedOut).toBe(true);

    // Further advance: no more fetches.
    const callsAtTimeout = fetcher.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetcher.mock.calls.length).toBe(callsAtTimeout);
  });

  it('captures errors from the fetcher into `error`', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('boom'));
    let snapshot = null;
    renderHook({ userId: 'u1', app: 'slack', polling: false, fetcher }, (r) => (snapshot = r));
    await flushMicrotasks();
    expect(snapshot.error).toBe('boom');
    expect(snapshot.loading).toBe(false);
  });

  it('refetch() runs the fetcher on demand', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ app: 'slack', status: 'PENDING' })
      .mockResolvedValueOnce({ app: 'slack', status: 'CONNECTED' });
    let snapshot = null;
    renderHook({ userId: 'u1', app: 'slack', polling: false, fetcher }, (r) => (snapshot = r));
    await flushMicrotasks();
    expect(snapshot.data?.status).toBe('PENDING');

    await act(async () => {
      await snapshot.refetch();
    });
    expect(snapshot.data?.status).toBe('CONNECTED');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
