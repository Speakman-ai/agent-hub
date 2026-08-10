/**
 * post-push-background-shells.ts — stop a session's Hub-owned background
 * shells at the `pushed` terminal of a finalize run.
 *
 * A session that pushes through Finalize is locked into ask mode and demoted
 * to manual automation (`post-push-session-lock.ts`): it will never ship
 * another commit. Its background shells exist to support that shipping work,
 * so leaving them alive after the push is wrong twice over:
 *
 *   1. The process keeps running. A build, a watcher, or a test matrix goes on
 *      burning CPU in a worktree nobody will touch again, until the session is
 *      archived (`routes/sessions.ts`) or the Hub restarts.
 *   2. The watch loop can still fire. An armed shell that finishes after the
 *      push dispatches a wake turn into a session the operator considers
 *      closed — the turn runs read-only, produces nothing shippable, and reads
 *      as the session spontaneously talking to itself.
 *
 * This runs **once**, at push time. Anything started afterwards — by the
 * operator, by a follow-up session, or by a post-finalize trigger — is a new
 * shell and behaves normally. "Doesn't survive Finalize" is a teardown at the
 * push boundary, not a standing ban on the feature.
 *
 * Non-throwing contract, same as `post-push-detach.ts`: the `pushed` status
 * and `pr_url` are already persisted by the time we are called. A shell that
 * refuses to die is worth a log line, never grounds to fail a successful push.
 */
import { randomUUID } from 'crypto';
import type { BroadcastFn, MessageRow, Stmts } from '../types.js';

/** The teardown surface of `BackgroundShellRuntime` this module needs. */
export interface PostPushShellRuntime {
  /**
   * Disarm and stop exactly the shells that existed when the call was made.
   * Snapshot-scoped on purpose — see the race note on the teardown below.
   */
  stopSessionSnapshot?: (sessionId: string) => Promise<Array<{ id: string }>>;
  /**
   * Session-wide sweep. Only used as a fallback when the runtime predates
   * {@link PostPushShellRuntime.stopSessionSnapshot}; it cannot honour the
   * post-boundary carve-out.
   */
  stopBySessionId: (sessionId: string) => Promise<number>;
}

export interface PostPushBackgroundShellDeps {
  stmts: Pick<Stmts, 'addMessage' | 'touchSession' | 'getMessageById'>;
  broadcast: BroadcastFn;
  getBackgroundShellRuntime?: () => PostPushShellRuntime | null | undefined;
  getBackgroundShellWatcher?: () => { forgetSession: (sessionId: string) => void } | null;
  /** Optional UUID minter for the notice message id. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
  /** Optional log sink. Defaults to `console.warn`. */
  log?: (msg: string) => void;
}

/**
 * Wrap the injected log sink so that logging can never break the teardown.
 *
 * The sink is injected, and it is called from inside every error handler here.
 * An unguarded `log()` in a `catch` block is the worst placement available: it
 * turns a handled, cosmetic failure into an escaping exception, at the one
 * point where the caller has already persisted a successful push.
 *
 * Fallback chain: the injected sink, then `console.warn` once, then silence.
 * There is nothing useful left to do after the console throws, and a logging
 * failure must never become a push failure.
 */
function makeSafeLog(sink: ((msg: string) => void) | undefined): (msg: string) => void {
  return (msg: string) => {
    try {
      (sink ?? console.warn)(msg);
    } catch {
      if (!sink) return; // console.warn itself threw; nothing left to try.
      try {
        console.warn(msg);
      } catch {
        /* give up silently */
      }
    }
  };
}

/**
 * Transcript line written when the push tears shells down.
 *
 * Without it the Background shells panel silently flips a running build to
 * `stopped` with no cause, which is indistinguishable from a crash. Pure so
 * the wording can be pinned without standing up the surrounding deps.
 */
export function buildPostFinalizePushShellTeardownNotice(stoppedCount: number): string {
  const noun = stoppedCount === 1 ? 'background shell' : 'background shells';
  return [
    `🛑 Finalize pushed this session, so its ${stoppedCount} running ${noun} ${
      stoppedCount === 1 ? 'was' : 'were'
    } stopped and the watch loop was disarmed.`,
    'Background work does not survive a Finalize push. Start a follow-up session if more long-running work is needed.',
  ].join('\n\n');
}

/**
 * Persist + broadcast the teardown notice.
 *
 * Individually guarded per side effect so each failure gets a log line that
 * names which step broke — but callers must still treat the whole function as
 * fallible and wrap it (see the call site). The id mint, the copy builder, and
 * the `JSON.stringify` at the top run before any of those inner `try`s, and
 * guarding them one expression at a time just moves the unprotected line
 * around. The call-site wrapper is the structural guarantee; these are for
 * diagnosability.
 */
function persistTeardownNotice(
  deps: PostPushBackgroundShellDeps,
  sessionId: string,
  stoppedCount: number,
  log: (msg: string) => void,
): void {
  const messageId = (deps.newId ?? randomUUID)();
  const content = buildPostFinalizePushShellTeardownNotice(stoppedCount);
  const metadata = JSON.stringify({
    kind: 'background_shell_finalize_push_teardown',
    stoppedCount,
  });
  try {
    deps.stmts.addMessage.run(
      messageId,
      sessionId,
      'system',
      content,
      null,
      null,
      null,
      metadata,
      null,
      null,
      null,
    );
  } catch (err) {
    log(
      `[post-push-bg-shells] notice insert failed session=${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  try {
    deps.stmts.touchSession.run(sessionId);
  } catch {
    /* best-effort */
  }
  try {
    const message = deps.stmts.getMessageById.get(messageId) as MessageRow | undefined;
    if (message) deps.broadcast({ type: 'message_added', sessionId, message });
  } catch (err) {
    log(
      `[post-push-bg-shells] notice broadcast failed session=${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Tear down `sessionId`'s background shells after a successful Finalize push.
 *
 * Order matters:
 *
 *   1. `forgetSession` drops the watcher's in-memory pending wakes first, so a
 *      completion already queued cannot race the kill into a wake turn.
 *   2. `stopSessionSnapshot` disarms and stops exactly the shells that existed
 *      at the boundary — armed and `--no-watch` alike — and re-emits
 *      armed-but-already-terminal rows so the UI's "watching" pill clears.
 *
 * **Why a snapshot and not a session-wide sweep.** This teardown takes real
 * time: stopping a shell awaits the SIGTERM grace before escalating, so a
 * session with several shells can sit here for seconds. A sweep that re-queries
 * the table at the end of that window would also kill anything started during
 * it, which directly contradicts the post-boundary carve-out below. Snapshot
 * the row set once, synchronously, and operate only on those ids.
 *
 * Returns the number of shells actually stopped (0 when the session had none).
 *
 * **Never throws, structurally.** Three review rounds found three different
 * unguarded expressions on this path (the runtime getter, the notice
 * prologue, the log sink), which is the signal that per-expression guarding
 * does not converge: every guard is correct and the next added line reopens
 * the hole. So the guarantee is enforced by construction instead —
 *
 *   - the whole body sits inside one outer `try`, so nothing reachable from
 *     here can escape, including expressions a future edit adds;
 *   - the log sink is wrapped by {@link makeSafeLog}, so the error handlers
 *     themselves — including the outer one — cannot throw;
 *   - `stopped` is declared outside the `try`, so an unexpected failure
 *     mid-teardown still reports the shells that were actually killed.
 *
 * The per-step `try` blocks below are kept for *diagnosability*, not safety:
 * they name which side effect failed, which the outer handler cannot. The
 * caller (`finalize/push-run.ts`) additionally guards its call, so even a
 * regression here cannot fail an already-persisted push.
 */
export async function stopBackgroundShellsAfterFinalizePush(
  deps: PostPushBackgroundShellDeps,
  sessionId: string | null | undefined,
): Promise<number> {
  const log = makeSafeLog(deps.log);
  if (!sessionId) return 0;

  let stopped = 0;
  try {
    let runtime: PostPushShellRuntime | null | undefined;
    try {
      runtime = deps.getBackgroundShellRuntime?.();
    } catch (err) {
      log(
        `[post-push-bg-shells] runtime lookup failed session=${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }
    if (!runtime) return 0;

    try {
      deps.getBackgroundShellWatcher?.()?.forgetSession(sessionId);
    } catch (err) {
      log(
        `[post-push-bg-shells] forgetSession failed session=${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // NB: reading `runtime.stopSessionSnapshot` is itself a call into injected
    // code when the runtime exposes it as a getter — one more reason the outer
    // wrapper, not this `if`, is what holds the contract.
    if (runtime.stopSessionSnapshot) {
      try {
        stopped += (await runtime.stopSessionSnapshot(sessionId)).length;
      } catch (err) {
        log(
          `[post-push-bg-shells] stopSessionSnapshot failed session=${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      // Fallback for a runtime without the snapshot operation. Session-wide,
      // so it cannot honour the post-boundary carve-out; logged loudly rather
      // than silently changing the semantics.
      log(
        `[post-push-bg-shells] runtime has no stopSessionSnapshot; falling back to a session-wide sweep session=${sessionId}`,
      );
      try {
        stopped += await runtime.stopBySessionId(sessionId);
      } catch (err) {
        log(
          `[post-push-bg-shells] stopBySessionId failed session=${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (stopped > 0) {
      log(`[post-push-bg-shells] stopped ${stopped} shell(s) after push session=${sessionId}`);
      // Wrapped as a whole rather than per-expression: the notice's prologue
      // (id mint, copy builder, metadata serialize) runs before its own inner
      // guards, so one wrapper covers all of it and anything added later.
      try {
        persistTeardownNotice(deps, sessionId, stopped, log);
      } catch (err) {
        log(
          `[post-push-bg-shells] teardown notice failed session=${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } catch (err) {
    // The backstop. Reaching it means an expression on this path had no guard
    // of its own — a bug worth the loud log, but never worth failing a push
    // that is already on GitHub.
    log(
      `[post-push-bg-shells] teardown failed unexpectedly session=${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return stopped;
}
