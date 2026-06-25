import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startVisibleIntervalRefresh } from './visibleIntervalRefresh.js';

/**
 * A controllable visibility source: starts visible, lets a test flip it and
 * notify subscribers, mirroring `visibilitychange` (web) / `AppState` (mobile).
 */
function makeVisibility(initial = true) {
  let visible = initial;
  const subs = new Set<(v: boolean) => void>();
  return {
    isVisible: () => visible,
    subscribe: (cb: (v: boolean) => void) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    set(next: boolean) {
      visible = next;
      for (const cb of subs) cb(next);
    },
  };
}

describe('startVisibleIntervalRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires every interval while visible, but not on start', () => {
    const vis = makeVisibility(true);
    const onRefresh = vi.fn();
    const stop = startVisibleIntervalRefresh({
      onRefresh,
      intervalMs: 5000,
      isVisible: vis.isVisible,
      subscribeVisibility: vis.subscribe,
    });

    expect(onRefresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it('does not fire while hidden and resumes (with catch-up) when visible again', () => {
    const vis = makeVisibility(true);
    const onRefresh = vi.fn();
    const stop = startVisibleIntervalRefresh({
      onRefresh,
      intervalMs: 5000,
      isVisible: vis.isVisible,
      subscribeVisibility: vis.subscribe,
      runOnVisible: true,
    });

    // Hide: timer is cleared, so time passing does nothing.
    vis.set(false);
    vi.advanceTimersByTime(60_000);
    expect(onRefresh).not.toHaveBeenCalled();

    // Return to visible: immediate catch-up run, then the timer rearms.
    vis.set(true);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it('honors runOnVisible=false (no catch-up run on resume)', () => {
    const vis = makeVisibility(true);
    const onRefresh = vi.fn();
    const stop = startVisibleIntervalRefresh({
      onRefresh,
      intervalMs: 5000,
      isVisible: vis.isVisible,
      subscribeVisibility: vis.subscribe,
      runOnVisible: false,
    });
    vis.set(false);
    vis.set(true);
    expect(onRefresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not arm a timer while starting hidden', () => {
    const vis = makeVisibility(false);
    const onRefresh = vi.fn();
    const stop = startVisibleIntervalRefresh({
      onRefresh,
      intervalMs: 5000,
      isVisible: vis.isVisible,
      subscribeVisibility: vis.subscribe,
    });
    vi.advanceTimersByTime(60_000);
    expect(onRefresh).not.toHaveBeenCalled();
    stop();
  });

  it('serializes async refreshes: a slow refresh skips overlapping ticks', async () => {
    const vis = makeVisibility(true);
    const ctl: { resolve: (() => void) | null } = { resolve: null };
    const onRefresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          ctl.resolve = resolve;
        }),
    );
    const stop = startVisibleIntervalRefresh({
      onRefresh,
      intervalMs: 5000,
      isVisible: vis.isVisible,
      subscribeVisibility: vis.subscribe,
    });

    // First tick starts a refresh that does not resolve yet.
    vi.advanceTimersByTime(5000);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Several more ticks pass while the first refresh is still in flight —
    // all are skipped by the in-flight guard.
    vi.advanceTimersByTime(15_000);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // The in-flight refresh resolves; the guard releases on the microtask.
    ctl.resolve?.();
    await Promise.resolve();
    await Promise.resolve();

    // The next tick is free to fire again.
    vi.advanceTimersByTime(5000);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it('a returning-visible run is skipped while a refresh is still in flight', async () => {
    const vis = makeVisibility(true);
    const ctl: { resolve: (() => void) | null } = { resolve: null };
    const onRefresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          ctl.resolve = resolve;
        }),
    );
    const stop = startVisibleIntervalRefresh({
      onRefresh,
      intervalMs: 5000,
      isVisible: vis.isVisible,
      subscribeVisibility: vis.subscribe,
      runOnVisible: true,
    });

    vi.advanceTimersByTime(5000);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Background then foreground while the refresh is still pending: the
    // catch-up run must not stack a second concurrent request.
    vis.set(false);
    vis.set(true);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    ctl.resolve?.();
    await Promise.resolve();
    await Promise.resolve();
    // After release, a subsequent visible-resume run is allowed.
    vis.set(false);
    vis.set(true);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it('swallows a synchronous throw from onRefresh and keeps polling', () => {
    const vis = makeVisibility(true);
    let calls = 0;
    const onRefresh = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw new Error('sync boom');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const stop = startVisibleIntervalRefresh({
      onRefresh,
      intervalMs: 5000,
      isVisible: vis.isVisible,
      subscribeVisibility: vis.subscribe,
    });

    // The throwing tick must not escape into the timer handler…
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();

    // …and the guard is released, so the loop keeps polling.
    vi.advanceTimersByTime(5000);
    expect(onRefresh).toHaveBeenCalledTimes(2);

    errSpy.mockRestore();
    stop();
  });

  it('releases the guard and keeps polling after an async rejection', async () => {
    const vis = makeVisibility(true);
    const onRefresh = vi.fn(() => Promise.reject(new Error('async boom')));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const stop = startVisibleIntervalRefresh({
      onRefresh,
      intervalMs: 5000,
      isVisible: vis.isVisible,
      subscribeVisibility: vis.subscribe,
    });

    vi.advanceTimersByTime(5000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    // Let the rejection settle and release the guard.
    await Promise.resolve();
    await Promise.resolve();
    expect(errSpy).toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    expect(onRefresh).toHaveBeenCalledTimes(2);

    errSpy.mockRestore();
    stop();
  });

  it('teardown unsubscribes and stops the timer', () => {
    const vis = makeVisibility(true);
    const onRefresh = vi.fn();
    const stop = startVisibleIntervalRefresh({
      onRefresh,
      intervalMs: 5000,
      isVisible: vis.isVisible,
      subscribeVisibility: vis.subscribe,
    });
    vi.advanceTimersByTime(5000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    // A post-teardown visibility change is ignored (unsubscribed).
    vis.set(false);
    vis.set(true);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
