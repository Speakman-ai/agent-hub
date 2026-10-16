/**
 * Sleep for `ms`, or less if `signal` aborts first. Whichever happens first
 * also undoes the other: the timer is cleared on abort, and the abort
 * listener is removed when the timer fires. Loops that sleep on one
 * long-lived signal (a desktop's hold, a ready-report retry) therefore don't
 * pile up a listener per iteration. Resolves either way, never rejects.
 */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
