/**
 * run-abort-registry.ts — in-process cancellation for live Finalize runs.
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

/** Associate an abort handle with a live run so cancel can find it. */
export function registerFinalizeRunAbort(runId: string, abort: () => void): void {
  if (!runId) return;
  abortFns.set(runId, abort);
}

/** Drop a run's registration once it settles (terminal or thrown). */
export function unregisterFinalizeRunAbort(runId: string): void {
  if (!runId) return;
  abortFns.delete(runId);
}

/**
 * Is an orchestrator currently driving this run in THIS process? True iff an
 * abort handle is registered (kickoff registers one and `.finally`
 * unregisters when `runFinalize` settles — including on throw). The runtime
 * stuck-run reaper (`stuck-run-reaper.ts`) uses this as its liveness oracle:
 * a non-terminal DB row with NO live handle is, under the single-process
 * architecture, definitively not being driven and is safe to reap once idle.
 */
export function isFinalizeRunLive(runId: string): boolean {
  return abortFns.has(runId);
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
}
