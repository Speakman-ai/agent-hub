/**
 * push-lock.ts — one landing at a time per (project, base branch).
 *
 * The base-drift check (`base-drift.ts`) tells a run whether the base moved
 * onto ground it touches. On its own that is still check-then-act: two
 * sessions can both re-resolve the same base tip, both get `clear`, and both
 * push and merge, which is the concurrent-landing failure the check exists
 * to prevent. Narrowing the window is not closing it.
 *
 * This module closes it by serializing the whole check-through-landing
 * sequence on the thing being contended: the base branch of a project. While
 * one run holds the lock, another run's drift check does not run at all — it
 * waits, and when it gets the lock the base already carries whatever the
 * previous holder landed, so its drift check sees the real state.
 *
 * ## Mechanics
 *
 * `INSERT OR IGNORE` on a `(project_id, base_branch)` primary key IS the
 * mutex: better-sqlite3 serializes writers, so exactly one caller sees
 * `changes === 1`. No advisory-lock machinery, no separate lock service.
 *
 * **Re-entrant by holder run id.** The automation path takes the lock around
 * push *and* auto-merge, then calls `runFinalizePush`, which takes it again.
 * A second acquire by the same run id returns a handle whose `release()` is a
 * no-op, so the inner scope cannot free the outer scope's lock.
 *
 * **Stale takeover, with a heartbeat.** A holder that crashed mid-push would
 * otherwise wedge every future push on that base, so any row older than
 * {@link PUSH_LOCK_STALE_MS} is deleted before each acquire attempt. A *live*
 * holder must not be mistaken for a dead one: a push plus an awaited
 * auto-merge can exceed the stale window, so the handle heartbeats
 * `acquired_at` every {@link PUSH_LOCK_RENEW_MS} for as long as it is held.
 * Takeover therefore only happens when the holder has genuinely stopped
 * renewing (process died, host lost). Releases and renewals are both
 * holder-scoped, so a zombie that wakes up after takeover can neither free
 * nor refresh the new holder's lock.
 *
 * **Bounded wait, then refuse.** Waiting forever would hang an automation
 * turn; refusing immediately would make a normal two-session day noisy. We
 * poll for {@link PUSH_LOCK_WAIT_MS} and then refuse with a retryable error —
 * the run stays `ready_to_push`, so a later push (human or automation) picks
 * it up.
 *
 * **Fail open when the statements are absent.** Callers that inject a partial
 * `stmts` (unit tests, older embedders) get a no-op handle rather than a
 * crash: this is a serialization aid, not an authorization gate.
 *
 * ## Boundary
 *
 * The lock covers check → push → merge *within Finalize*. Under the `manual`
 * and `review` automation levels the merge happens later on GitHub, outside
 * any hold, so two branches can still land minutes apart there; the drift
 * check plus GitHub's own merge protections are what cover that case.
 */
import type { Stmts } from '../types.js';

export const PUSH_LOCK_BUSY_ERROR = 'base_push_in_progress';
export const PUSH_LOCK_BUSY_MESSAGE =
  'Another Finalize run is pushing to this base branch right now. ' +
  'Wait for it to finish, then push again.';

/** How long a lock may be held before another run may take it over. */
export const PUSH_LOCK_STALE_MS = 15 * 60_000;
/** How long an acquire waits for the current holder before refusing. */
export const PUSH_LOCK_WAIT_MS = 120_000;
/** Gap between acquire attempts while waiting. */
export const PUSH_LOCK_POLL_MS = 500;
/**
 * Heartbeat interval for a held lock. Comfortably below
 * {@link PUSH_LOCK_STALE_MS} so several renewals can be missed before another
 * run is allowed to take over.
 */
export const PUSH_LOCK_RENEW_MS = 60_000;

/**
 * Optional on every field: callers that inject a partial `stmts` (unit tests,
 * embedders on an older schema) get a no-op lock rather than a crash.
 */
export type PushLockStmts = Partial<
  Pick<
    Stmts,
    | 'acquireFinalizePushLock'
    | 'getFinalizePushLock'
    | 'releaseFinalizePushLock'
    | 'expireFinalizePushLock'
    | 'touchFinalizePushLock'
  >
>;

export interface PushLockHandle {
  /** Release the lock. Idempotent, and a no-op for a re-entrant acquire. */
  release(): void;
  /**
   * Push `acquired_at` forward so a still-running hold is not taken over as
   * stale. Called automatically on a timer while held; exposed so tests can
   * drive it deterministically. No-op after release.
   */
  renew(): void;
  /** True when this acquire nested inside a hold by the same run. */
  reentrant: boolean;
}

export type AcquirePushLockResult =
  | { ok: true; handle: PushLockHandle }
  | { ok: false; heldBy: string | null };

const NOOP_HANDLE: PushLockHandle = { release: () => {}, renew: () => {}, reentrant: false };

/** Timer seam so tests do not depend on wall-clock intervals. */
export interface PushLockTimers {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

const DEFAULT_TIMERS: PushLockTimers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    // Never hold the process open for a lock heartbeat.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

interface PushLockRow {
  project_id: string;
  base_branch: string;
  holder_run_id: string;
  acquired_at: number;
}

/**
 * Take the landing lock for `(projectId, baseBranch)`, waiting up to
 * {@link PUSH_LOCK_WAIT_MS} for a current holder to finish.
 *
 * @example
 *   const lock = await acquirePushLock({ stmts, projectId, baseBranch, holderRunId: run.id });
 *   if (!lock.ok) return { ok: false, httpStatus: 409, error: PUSH_LOCK_BUSY_ERROR, ... };
 *   try { ...drift check, push, merge... } finally { lock.handle.release(); }
 */
export async function acquirePushLock(args: {
  stmts: PushLockStmts;
  projectId: string;
  baseBranch: string;
  holderRunId: string;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  staleMs?: number;
  pollMs?: number;
  renewMs?: number;
  /** Injectable timers for the heartbeat. */
  timers?: PushLockTimers;
}): Promise<AcquirePushLockResult> {
  const { stmts, projectId, baseBranch, holderRunId } = args;
  const acquire = stmts.acquireFinalizePushLock;
  const read = stmts.getFinalizePushLock;
  if (!acquire || !read) return { ok: true, handle: NOOP_HANDLE };

  const now = args.now ?? (() => Date.now());
  const sleep = args.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const waitMs = args.waitMs ?? PUSH_LOCK_WAIT_MS;
  const staleMs = args.staleMs ?? PUSH_LOCK_STALE_MS;
  const pollMs = args.pollMs ?? PUSH_LOCK_POLL_MS;

  const deadline = now() + waitMs;
  let heldBy: string | null = null;

  for (;;) {
    // Clear a dead holder first so takeover happens in the same attempt.
    try {
      stmts.expireFinalizePushLock?.run(projectId, baseBranch, now() - staleMs);
    } catch {
      /* best-effort: a failed expiry just means we wait for the real holder */
    }

    const result = acquire.run(projectId, baseBranch, holderRunId, now()) as { changes: number };
    if (result.changes === 1) {
      return {
        ok: true,
        handle: makeHandle({
          stmts,
          projectId,
          baseBranch,
          holderRunId,
          now,
          renewMs: args.renewMs ?? PUSH_LOCK_RENEW_MS,
          timers: args.timers ?? DEFAULT_TIMERS,
        }),
      };
    }

    const row = read.get(projectId, baseBranch) as PushLockRow | undefined;
    heldBy = row?.holder_run_id ?? null;
    if (heldBy === holderRunId) {
      // Same run, outer scope already holds it. Releasing here would free the
      // outer hold early, and the outer handle already heartbeats, so this
      // handle deliberately does nothing.
      return { ok: true, handle: { release: () => {}, renew: () => {}, reentrant: true } };
    }
    if (!row) {
      // Holder vanished between the failed insert and the read — retry now
      // rather than sleeping through an unlocked window.
      continue;
    }
    if (now() >= deadline) return { ok: false, heldBy };
    await sleep(pollMs);
  }
}

function makeHandle(args: {
  stmts: PushLockStmts;
  projectId: string;
  baseBranch: string;
  holderRunId: string;
  now: () => number;
  renewMs: number;
  timers: PushLockTimers;
}): PushLockHandle {
  const { stmts, projectId, baseBranch, holderRunId, now, renewMs, timers } = args;
  let released = false;

  const renew = () => {
    if (released) return;
    try {
      // Holder-scoped: a zombie whose lock was already taken over cannot
      // refresh the new holder's row.
      stmts.touchFinalizePushLock?.run(now(), projectId, baseBranch, holderRunId);
    } catch (err) {
      // A missed heartbeat is survivable (several fit inside the stale
      // window); a silent one is not.
      console.warn(
        `[finalize-push-lock] heartbeat failed for ${projectId}/${baseBranch} ` +
          `holder=${holderRunId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const timer = timers.setInterval(renew, renewMs);

  return {
    reentrant: false,
    renew,
    release: () => {
      if (released) return;
      released = true;
      timers.clearInterval(timer);
      try {
        stmts.releaseFinalizePushLock?.run(projectId, baseBranch, holderRunId);
      } catch (err) {
        // A lock we cannot release ages out via the stale window; log so the
        // condition is visible rather than silently serializing everything.
        console.warn(
          `[finalize-push-lock] release failed for ${projectId}/${baseBranch} ` +
            `holder=${holderRunId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
