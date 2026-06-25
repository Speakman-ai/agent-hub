/**
 * Framework-free core of the "refresh on a timer while the surface is visible"
 * pattern shared by the web (`document.visibilityState`) and mobile
 * (`AppState`) `useVisibleIntervalRefresh` hooks.
 *
 * Responsibilities:
 *   - Run `onRefresh` every `intervalMs` while the surface is visible.
 *   - Clear the timer when the surface is hidden/backgrounded (save work,
 *     network, and battery), and optionally run once when it returns to visible.
 *   - **Serialize refreshes with an in-flight guard**: while a refresh promise
 *     is still pending, ticks (and visible-resume runs) are skipped rather than
 *     stacked. Because only one request is ever in flight, a slow response can
 *     never resolve after a newer one and overwrite fresher data with stale,
 *     and a slow API cannot accumulate concurrent polls.
 *
 * It never runs `onRefresh` on start — callers own their initial load — so this
 * is strictly for foreground polling / background-idle reconciliation.
 *
 * Pure on purpose: no DOM, no React, no React Native imports, so it unit-tests
 * with fake timers in a plain node environment.
 */
export interface VisibleIntervalRefreshOptions {
  /** The work to run on each tick. May be sync or return a Promise. */
  onRefresh: () => unknown | Promise<unknown>;
  /** Poll interval in milliseconds. */
  intervalMs: number;
  /** True when the surface is foreground/visible right now. */
  isVisible: () => boolean;
  /**
   * Subscribe to visibility changes; the callback receives the new visibility
   * (`true` = visible). Must return an unsubscribe function.
   */
  subscribeVisibility: (cb: (visible: boolean) => void) => () => void;
  /** Run once when transitioning back to visible (default `true`). */
  runOnVisible?: boolean;
  /** Timer scheduler injection (defaults to the ambient `setInterval`). */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  /** Timer canceller injection (defaults to the ambient `clearInterval`). */
  clearIntervalFn?: (id: unknown) => void;
}

/**
 * Start the visible-interval refresh loop. Returns a teardown function that
 * unsubscribes from visibility changes and clears any pending timer.
 */
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

  // Release the guard. On failure, swallow the error: this helper is shared
  // infrastructure driving a timer (web) / AppState (RN) callback, so a thrown
  // error must never escape as a global unhandled exception that recurs every
  // tick — one bad refresh just fails that poll and the loop continues.
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
    // In-flight guard: never overlap refreshes. Skipping (not queueing) keeps
    // at most one request alive, so a stale response can't land after a fresher
    // one. `onRefresh` is invoked synchronously so callers that return void
    // behave exactly as before; only a returned Promise holds the guard.
    if (running) return;
    running = true;
    let result: unknown;
    try {
      result = onRefresh();
    } catch (err) {
      // A synchronous throw is treated exactly like a rejected promise: release
      // the guard and suppress/log, rather than letting it propagate into the
      // timer/visibility handler.
      fail(err);
      return;
    }
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      // Async: release when the promise settles (success or rejection).
      (result as Promise<unknown>).then(release, fail);
    } else {
      // Synchronous success: release immediately.
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
