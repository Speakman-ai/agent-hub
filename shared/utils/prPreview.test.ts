import { describe, it, expect, vi } from 'vitest';
import {
  prPreviewViewState,
  prPreviewAvailable,
  prPreviewCanStart,
  prEnvironmentPollMs,
  PR_ENV_POLL_ACTIVE_MS,
  PR_ENV_POLL_IDLE_MS,
  startPrEnvironmentPoller,
} from './prPreview';

describe('prPreviewViewState', () => {
  it('idle when there is no environment and nothing pending', () => {
    expect(prPreviewViewState(null)).toMatchObject({ status: 'idle', phase: null, url: null });
    expect(prPreviewViewState({ environment: null })).toMatchObject({ status: 'idle' });
  });

  it('loading while a just-clicked Start has no state yet', () => {
    expect(prPreviewViewState({ environment: null }, { pending: true })).toMatchObject({
      status: 'loading',
    });
  });

  it('queued and building are loading with distinct labels and the log tail', () => {
    expect(prPreviewViewState({ environment: { status: 'queued', logTail: [] } })).toMatchObject({
      status: 'loading',
      phase: 'queued',
      label: expect.stringMatching(/queued/i),
    });
    expect(
      prPreviewViewState({ environment: { status: 'building', logTail: ['compose up'] } }),
    ).toMatchObject({ status: 'loading', phase: 'building', logTail: ['compose up'] });
  });

  it('ready carries the url', () => {
    expect(
      prPreviewViewState({ environment: { status: 'ready', url: 'https://pr-5.example/' } }),
    ).toMatchObject({ status: 'ready', url: 'https://pr-5.example/' });
  });

  it('failed surfaces the error, with a generic fallback', () => {
    expect(
      prPreviewViewState({ environment: { status: 'failed', error: 'health check timed out' } }),
    ).toMatchObject({ status: 'failed', reason: 'health check timed out' });
    expect(prPreviewViewState({ environment: { status: 'failed' } }).reason).toMatch(/failed/);
  });

  it('stopped is idle and explains why', () => {
    expect(
      prPreviewViewState({ environment: { status: 'stopped', stopReason: 'merged' } }),
    ).toMatchObject({ status: 'idle', phase: 'stopped', reason: expect.stringMatching(/merged/) });
  });

  it('a stopped env whose teardown failed says so and flags cleanup', () => {
    const v = prPreviewViewState({
      environment: {
        status: 'stopped',
        stopReason: 'manual',
        cleanupPending: true,
        error: 'Teardown failed: docker down',
      },
    });
    expect(v).toMatchObject({ status: 'idle', cleanupPending: true });
    expect(v.reason).toMatch(/Teardown did not finish.*Stop again to retry/);
  });

  it('a stopped env with a fresh Start pending shows loading', () => {
    expect(
      prPreviewViewState({ environment: { status: 'stopped' } }, { pending: true }),
    ).toMatchObject({ status: 'loading' });
  });

  it('an unknown status degrades to idle, never a false ready', () => {
    expect(prPreviewViewState({ environment: { status: 'weird' } })).toMatchObject({
      status: 'idle',
    });
  });
});

describe('prPreviewAvailable', () => {
  it('true for open PRs that declare a PR environment, native or GitHub', () => {
    expect(
      prPreviewAvailable({
        source: 'agenthub',
        preview_available: true,
        pr: { state: 'open' },
      } as any),
    ).toBe(true);
    expect(
      prPreviewAvailable({
        source: 'github',
        preview_available: true,
        pr: { state: 'open' },
      } as any),
    ).toBe(true);
  });

  it('follows the server flag, including on closed/merged PRs with pending cleanup', () => {
    expect(prPreviewAvailable({ preview_available: false, pr: { state: 'open' } })).toBe(false);
    expect(prPreviewAvailable({ preview_available: true, pr: { state: 'closed' } })).toBe(true);
    expect(
      prPreviewAvailable({ preview_available: true, pr: { state: 'closed', merged_at: 'x' } }),
    ).toBe(true);
    expect(prPreviewAvailable(null)).toBe(false);
  });
});

describe('prPreviewCanStart', () => {
  it('only on open, unmerged PRs whose panel is shown', () => {
    expect(prPreviewCanStart({ preview_available: true, pr: { state: 'open' } })).toBe(true);
    expect(prPreviewCanStart({ preview_available: true, pr: { state: 'closed' } })).toBe(false);
    expect(
      prPreviewCanStart({ preview_available: true, pr: { state: 'open', merged_at: 'x' } }),
    ).toBe(false);
    expect(prPreviewCanStart({ preview_available: false, pr: { state: 'open' } })).toBe(false);
    expect(prPreviewCanStart({ preview_available: true })).toBe(false);
  });
});

describe('prEnvironmentPollMs', () => {
  it('polls fast while building and keeps polling, slower, otherwise', () => {
    expect(prEnvironmentPollMs('loading')).toBe(PR_ENV_POLL_ACTIVE_MS);
    for (const status of ['idle', 'ready', 'failed'] as const) {
      expect(prEnvironmentPollMs(status)).toBe(PR_ENV_POLL_IDLE_MS);
    }
  });
});

describe('startPrEnvironmentPoller', () => {
  function harness() {
    const timers: Array<() => void> = [];
    return {
      timers,
      schedule: (fn: () => void) => {
        timers.push(fn);
        return timers.length;
      },
      cancel: vi.fn(),
      /** Fire the most recently scheduled poll and let it settle. */
      async fire() {
        timers.pop()!();
        await new Promise((r) => setTimeout(r, 0));
      },
    };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('keeps polling after a rejected read, and delivers the next success', async () => {
    const h = harness();
    const fetchState = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ environment: { status: 'ready' } });
    const onState = vi.fn();
    const stop = startPrEnvironmentPoller({
      fetchState,
      onState,
      nextDelayMs: () => 15000,
      schedule: h.schedule,
      cancel: h.cancel,
    });
    await flush();
    expect(onState).not.toHaveBeenCalled();
    expect(h.timers).toHaveLength(1); // re-armed despite the failure

    await h.fire();
    expect(onState).toHaveBeenCalledWith({ environment: { status: 'ready' } });
    expect(h.timers).toHaveLength(1);
    stop();
  });

  it('keeps polling when the result never changes', async () => {
    const h = harness();
    const fetchState = vi.fn().mockResolvedValue({ environment: { status: 'ready' } });
    startPrEnvironmentPoller({
      fetchState,
      onState: () => {},
      nextDelayMs: () => 15000,
      schedule: h.schedule,
      cancel: h.cancel,
    });
    await flush();
    await h.fire();
    await h.fire();
    expect(fetchState).toHaveBeenCalledTimes(3);
    expect(h.timers).toHaveLength(1);
  });

  it('stop cancels the next read and drops a result that lands afterwards', async () => {
    const h = harness();
    let resolve!: (v: unknown) => void;
    const fetchState = vi.fn(() => new Promise((r) => (resolve = r)));
    const onState = vi.fn();
    const stop = startPrEnvironmentPoller({
      fetchState,
      onState,
      nextDelayMs: () => 15000,
      schedule: h.schedule,
      cancel: h.cancel,
    });
    stop();
    resolve({ environment: { status: 'ready' } });
    await flush();
    expect(onState).not.toHaveBeenCalled();
    expect(h.timers).toHaveLength(0);
  });

  it('reads the delay after each read settles', async () => {
    const h = harness();
    const delays: number[] = [];
    let status: 'loading' | 'ready' = 'loading';
    startPrEnvironmentPoller({
      fetchState: async () => null,
      onState: () => {
        status = 'ready';
      },
      nextDelayMs: () => {
        const ms = prEnvironmentPollMs(status);
        delays.push(ms);
        return ms;
      },
      schedule: h.schedule,
      cancel: h.cancel,
    });
    await flush();
    expect(delays).toEqual([PR_ENV_POLL_IDLE_MS]);
  });
});
