/**
 * Refresh on a timer while visible. Skip ticks while a refresh is in flight.
 * Does not run on start; callers own the initial load.
 */
export interface VisibleIntervalRefreshOptions {
  onRefresh: () => unknown | Promise<unknown>;
  intervalMs: number;
  isVisible: () => boolean;
  /** Callback gets the new visibility. Must return unsubscribe. */
  subscribeVisibility: (cb: (visible: boolean) => void) => () => void;
  /** Run once when returning to visible (default true). */
  runOnVisible?: boolean;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (id: unknown) => void;
}

/** Start the loop. Returned teardown unsubscribes and clears the timer. */
export function startVisibleIntervalRefresh(opts: VisibleIntervalRefreshOptions): () => void {
  const {
    onRefresh,
    intervalMs,
    isVisible,
    subscribeVisibility,
    runOnVisible = true,
    setIntervalFn,
    clearIntervalFn,
  } = opts;

  const schedule = setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const unschedule = clearIntervalFn ?? ((id: unknown) => clearInterval(id as never));

  let intervalId: unknown = null;
  let running = false;

  // Swallow errors: a thrown refresh must not become an unhandled exception every tick.
  const release = () => {
    running = false;
  };
  const fail = (err: unknown) => {
    running = false;
    try {
      console.error('visibleIntervalRefresh: onRefresh failed', err);
    } catch {
      /* ignore logging failures */
    }
  };

  const run = () => {
    if (running) return;
    running = true;
    let result: unknown;
    try {
      result = onRefresh();
    } catch (err) {
      fail(err);
      return;
    }
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      (result as Promise<unknown>).then(release, fail);
    } else {
      release();
    }
  };

  const clearTimer = () => {
    if (intervalId != null) {
      unschedule(intervalId);
      intervalId = null;
    }
  };

  const armTimer = () => {
    clearTimer();
    if (!isVisible()) return;
    intervalId = schedule(run, intervalMs);
  };

  const onVisibilityChange = (visible: boolean) => {
    if (visible) {
      if (runOnVisible) run();
      armTimer();
    } else {
      clearTimer();
    }
  };

  armTimer();
  const unsubscribe = subscribeVisibility(onVisibilityChange);

  return () => {
    unsubscribe();
    clearTimer();
  };
}
