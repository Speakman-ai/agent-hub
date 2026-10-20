/**
 * In-process cancellation for live Finalize runs.
 *
 * The orchestrator honors a {@link CancelSignal} at every awaitable boundary
 * (see `orchestrator.ts` §12), but the HTTP cancel route runs in a different
 * call stack than `runFinalize`. This registry bridges the two: a run's
 * kickoff registers an abort handle keyed by `runId`, and the cancel route
 * calls {@link abortFinalizeRunInProcess} to flip the signal — stopping the
 * fix-dispatch loop and killing any in-flight reviewer turn cleanly so the
 * session falls idle and waits for user input.
 *
 * Without this, cancel was UI-only: the DB row flipped to `cancelled` but the
 * orchestrator kept looping and could dispatch another fix turn.
 */
import type { CancelSignal } from './fix-dispatch.js';

interface AbortableSignal extends CancelSignal {
  /** Trip the signal: marks aborted and fans out to listeners once. */
  trip(): void;
}

/** Build a fresh {@link CancelSignal} backed by a one-shot trip(). */
export function createFinalizeRunSignal(): { signal: CancelSignal; abort: () => void } {
  let aborted = false;
  const listeners = new Set<() => void>();
  const signal: AbortableSignal = {
    get aborted() {
      return aborted;
    },
    onAbort(listener: () => void): () => void {
      if (aborted) {
        // Already tripped — fire immediately, mirror AbortSignal semantics.
        try {
          listener();
        } catch {
          /* best-effort */
        }
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    trip() {
      if (aborted) return;
      aborted = true;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          /* best-effort — one bad listener must not block the rest */
        }
      }
      listeners.clear();
    },
  };
  return { signal, abort: () => signal.trip() };
}

const abortFns = new Map<string, () => void>();
// Aborting requests shutdown; only the orchestrator finally confirms settlement.
const liveRuns = new Set<string>();
// Infra retry rows opened inside the same runFinalize call, keyed by the run id
// the kickoff registered. Kickoff only knows that first id, so its settle-time
// unregister has to clear the retries too.
const retryRunsByRoot = new Map<string, Set<string>>();
const rootByRetryRun = new Map<string, string>();

/** Associate an abort handle with a live run so cancel can find it. */
export function registerFinalizeRunAbort(runId: string, abort: () => void): void {
  if (!runId) return;
  abortFns.set(runId, abort);
  liveRuns.add(runId);
}

/** Drop a run's registration once it settles (terminal or thrown). */
export function unregisterFinalizeRunAbort(runId: string): void {
  if (!runId) return;
  abortFns.delete(runId);
  liveRuns.delete(runId);
  for (const retryId of retryRunsByRoot.get(runId) ?? []) {
    abortFns.delete(retryId);
    liveRuns.delete(retryId);
    rootByRetryRun.delete(retryId);
  }
  retryRunsByRoot.delete(runId);
}

/**
 * Carry a live registration from a parent run to the infra retry row the
 * orchestrator just opened for it. The retry is driven by the same
 * orchestrator and the same cancel signal, so it shares the parent's abort
 * handle. Without this the retry row reads as orphaned to the stuck-run
 * reaper, which fails it while the orchestrator is still running its checks.
 * Returns false (no-op) when the parent is not registered in this process.
 */
export function inheritFinalizeRunAbort(parentRunId: string, retryRunId: string): boolean {
  if (!parentRunId || !retryRunId) return false;
  const abort = abortFns.get(parentRunId);
  if (!abort || !liveRuns.has(parentRunId)) return false;
  const root = rootByRetryRun.get(parentRunId) ?? parentRunId;
  abortFns.set(retryRunId, abort);
  liveRuns.add(retryRunId);
  rootByRetryRun.set(retryRunId, root);
  let retries = retryRunsByRoot.get(root);
  if (!retries) {
    retries = new Set();
    retryRunsByRoot.set(root, retries);
  }
  retries.add(retryRunId);
  return true;
}

/**
 * Is an orchestrator currently driving this run in THIS process? True iff an
 * lifetime is registered (kickoff registers it and `.finally`
 * unregisters when `runFinalize` settles — including on throw). The runtime
 * stuck-run reaper (`stuck-run-reaper.ts`) uses this as its liveness oracle:
 * a non-terminal DB row with NO live handle is, under the single-process
 * architecture, definitively not being driven and is safe to reap once idle.
 */
export function isFinalizeRunLive(runId: string): boolean {
  return liveRuns.has(runId);
}

/**
 * Abort an in-process run by id. Returns true if a live run was found and
 * tripped; false if nothing was registered (already settled, or this run is
 * owned by a different process — the DB flip still stands either way).
 */
export function abortFinalizeRunInProcess(runId: string): boolean {
  const abort = abortFns.get(runId);
  if (!abort) return false;
  try {
    abort();
  } catch {
    /* best-effort */
  }
  abortFns.delete(runId);
  return true;
}

/** Test-only: clear all registrations. */
export function __clearFinalizeRunAbortRegistry(): void {
  abortFns.clear();
  liveRuns.clear();
  retryRunsByRoot.clear();
  rootByRetryRun.clear();
}
