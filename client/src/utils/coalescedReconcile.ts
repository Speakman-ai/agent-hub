/**
 * Coalesced, pass-capped reconcile runner extracted from KanbanBoard so its
 * concurrency contract is unit-testable without rendering the board.
 *
 * Contract:
 *  - While a reconcile is in flight, a new call does not start a second one; it
 *    marks a refresh as queued and returns the in-flight promise (coalescing).
 *  - The in-flight reconcile re-runs `reloadOnce` as long as a refresh was queued
 *    during the previous pass, but at most `maxPasses` times — so sustained
 *    activity can't spin it forever.
 *  - Critically: if the pass cap is reached (or a call arrives during the
 *    trailing settle) with a refresh STILL queued, `scheduleFollowUp` is invoked
 *    so the board never settles stale waiting on a WS event that may not arrive.
 */
export interface ReconcileRefs {
  /** Holds the in-flight reconcile promise, or null when idle. */
  inFlight: { current: Promise<unknown> | null };
  /** Set true when a refresh is requested while one is already running. */
  queued: { current: boolean };
}

export interface RunCoalescedReconcileOptions<T> {
  /** Max re-run passes for a single invocation (must be >= 1). */
  maxPasses: number;
  /** Perform one reload pass. Must not throw — resolve to undefined on failure. */
  reloadOnce: () => Promise<T | undefined>;
  /** Schedule another reconcile after this one settles (e.g. setTimeout(0)). */
  scheduleFollowUp: () => void;
}

export async function runCoalescedReconcile<T>(
  refs: ReconcileRefs,
  opts: RunCoalescedReconcileOptions<T>,
): Promise<T | undefined> {
  if (refs.inFlight.current) {
    refs.queued.current = true;
    return refs.inFlight.current as Promise<T | undefined>;
  }

  const run = async (): Promise<T | undefined> => {
    let latest: T | undefined;
    let passes = 0;
    do {
      refs.queued.current = false;
      passes += 1;
      latest = await opts.reloadOnce();
    } while (refs.queued.current && passes < opts.maxPasses);
    return latest;
  };

  const request = run();
  refs.inFlight.current = request;
  try {
    return await request;
  } finally {
    if (refs.inFlight.current === request) refs.inFlight.current = null;
    // A refresh queued while this ran — cap hit mid-burst, or a coalesced call
    // arrived during the trailing await — has no other trigger now. Hand it off.
    if (refs.queued.current) {
      refs.queued.current = false;
      opts.scheduleFollowUp();
    }
  }
}
