/**
 * Settles mainline landing slots whose push result is not known.
 *
 * Spec (wiki: autopilot-mainline-mode-spec-default-branch-deploy-verification):
 * - A `pushing` slot with no push in flight in this process (a restart, or an
 *   outcome write that was lost) moves to `uncertain`.
 * - An `uncertain` slot asks the remote. Present moves to `landed` (the deploy
 *   watcher takes it from there); absent moves to `idle` and Finalize runs
 *   again; unknown keeps the slot, backs off, and escalates once.
 * - The absent write also records `restartOwed` on the row. The restart is
 *   retried with backoff until a run is accepted or the restart is dropped
 *   (session stopped or expired, a human cancelled, automation is manual),
 *   and only then cleared, so a failed start survives sweeps and restarts.
 * - Every write is a compare-and-set on the stored `(phase, attemptId)`, so an
 *   answer that arrives after the slot moved on writes nothing.
 * - Only a completed git answer clears the attempt (see
 *   autopilot-mainline-remote-check.ts); timeouts and errors never do.
 */
import {
  clearMainlineRestartOwed,
  transitionMainlineSlot,
  type AutopilotRowStmts,
} from './session-autopilot-slot.js';
import { parseAutopilotSessionConfig } from '../shared/utils/sessionAutopilot.js';
import type { MainlineRestartOwed, MainlineSlot } from '../shared/utils/autopilotMainlineSlot.js';
import type { RemoteCommitAnswer } from './autopilot-mainline-remote-check.js';

export const MAINLINE_RECONCILE_BACKOFF_MIN_MS = 15_000;
export const MAINLINE_RECONCILE_BACKOFF_MAX_MS = 10 * 60_000;
/** An uncertain default branch is worth a human look sooner than a slow deploy. */
export const MAINLINE_RECONCILE_ESCALATE_AFTER_MS = 15 * 60_000;

export interface MainlineReconcileSession {
  id: string;
  agent_id: string;
}

export interface MainlineReconcilerDeps {
  stmts: AutopilotRowStmts;
  /** Whether this process still has the push for this attempt in flight. */
  isPushLive: (sessionId: string, attemptId: string) => boolean;
  /**
   * Ask the remote whether `sha` is on `branch`. May throw; a throw is
   * treated as unknown.
   */
  checkRemote: (args: {
    session: MainlineReconcileSession;
    sha: string;
    branch: string;
  }) => Promise<RemoteCommitAnswer>;
  /**
   * Start Finalize again after the commit was found absent. `accepted`: a run
   * now owns the commit (started, in flight, or parked and pushed). `dropped`:
   * the restart no longer applies (stopped, expired, cancelled, manual).
   * `retry`: a transient failure; asked again after a backoff. A throw is
   * `retry`.
   */
  restartFinalize: (sessionId: string) => Promise<MainlineRestartResult>;
  postNotice: (sessionId: string, content: string) => void;
  now?: () => number;
  log?: (message: string) => void;
}

export type MainlineRestartResult =
  | { kind: 'accepted'; detail: string }
  | { kind: 'dropped'; detail: string }
  | { kind: 'retry'; detail: string };

interface Backoff {
  failures: number;
  nextAt: number;
}

export function mainlineReconcileBackoffMs(failures: number): number {
  const n = Math.max(1, Math.floor(failures));
  const delay = MAINLINE_RECONCILE_BACKOFF_MIN_MS * 2 ** Math.min(n - 1, 16);
  return Math.min(delay, MAINLINE_RECONCILE_BACKOFF_MAX_MS);
}

function shortSha(sha: string | null): string {
  return (sha ?? '').slice(0, 7);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createMainlineReconciler(deps: MainlineReconcilerDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const backoffs = new Map<string, Backoff>();
  const pendingRestarts = new Map<string, Promise<void>>();

  function readState(
    sessionId: string,
  ): { slot: MainlineSlot; branch: string | null; restartOwed: MainlineRestartOwed | null } | null {
    const row = deps.stmts.getSession.get(sessionId) as
      | { autopilot_session_config?: string | null }
      | undefined;
    const cfg = parseAutopilotSessionConfig(row?.autopilot_session_config ?? null);
    if (!cfg || cfg.target !== 'mainline' || !cfg.mainline) return null;
    const branch = typeof cfg.branch === 'string' && cfg.branch.trim() ? cfg.branch.trim() : null;
    return { slot: cfg.mainline.slot, branch, restartOwed: cfg.mainline.restartOwed ?? null };
  }

  function nowIso(): string {
    return new Date(now()).toISOString();
  }

  /** `pushing` with no live push → `uncertain`. Returns the slot to continue with. */
  function sweepStrandedPush(
    session: MainlineReconcileSession,
    slot: MainlineSlot,
    branch: string | null,
  ): MainlineSlot | null {
    if (!slot.attemptId || deps.isPushLive(session.id, slot.attemptId)) return null;
    const write = transitionMainlineSlot({
      stmts: deps.stmts,
      sessionId: session.id,
      expect: { phase: 'pushing', attemptId: slot.attemptId },
      event: { type: 'push_unknown' },
      nowIso: nowIso(),
    });
    if (!write.wrote) {
      log(
        `[autopilot-reconcile] session=${session.id} attempt=${slot.attemptId} could not mark the ` +
          `stranded push uncertain (${write.reason})`,
      );
      return null;
    }
    deps.postNotice(
      session.id,
      `Autopilot lost track of the push of ${shortSha(slot.sha)} to ${branch ?? 'the default branch'}. ` +
        `It is checking the remote to see whether it landed.`,
    );
    return write.slot;
  }

  async function askRemote(
    session: MainlineReconcileSession,
    slot: MainlineSlot,
    branch: string | null,
  ): Promise<RemoteCommitAnswer> {
    if (!branch) return { kind: 'unknown', detail: 'the default branch is not recorded' };
    try {
      return await deps.checkRemote({ session, sha: slot.sha as string, branch });
    } catch (err) {
      return { kind: 'unknown', detail: `remote check threw: ${errMessage(err)}` };
    }
  }

  function noteUnknown(
    session: MainlineReconcileSession,
    slot: MainlineSlot,
    branch: string | null,
    key: string,
    detail: string,
  ): void {
    const failures = (backoffs.get(key)?.failures ?? 0) + 1;
    const delay = mainlineReconcileBackoffMs(failures);
    backoffs.set(key, { failures, nextAt: now() + delay });
    log(
      `[autopilot-reconcile] session=${session.id} attempt=${slot.attemptId} remote answer unknown ` +
        `(attempt ${failures}, retry in ${Math.round(delay / 1000)}s): ${detail}`,
    );
    const since = slot.enteredAt ? Date.parse(slot.enteredAt) : NaN;
    if (slot.escalatedAt || !Number.isFinite(since)) return;
    if (now() - since < MAINLINE_RECONCILE_ESCALATE_AFTER_MS) return;
    const escalated = transitionMainlineSlot({
      stmts: deps.stmts,
      sessionId: session.id,
      expect: { phase: 'uncertain', attemptId: slot.attemptId },
      event: { type: 'escalate' },
      nowIso: nowIso(),
    });
    if (escalated.wrote) {
      deps.postNotice(
        session.id,
        `Autopilot still cannot tell whether ${shortSha(slot.sha)} reached ${branch ?? 'the default branch'} ` +
          `(${detail}). It keeps checking; no new push or deploy starts until the remote answers.`,
      );
    }
  }

  /**
   * Settle one session's slot if it is `pushing` (stranded) or `uncertain`.
   * Never throws.
   */
  async function reconcile(session: MainlineReconcileSession): Promise<void> {
    try {
      await reconcileSlot(session);
    } catch (err) {
      log(`[autopilot-reconcile] session=${session.id} reconcile failed: ${errMessage(err)}`);
    }
  }

  async function reconcileSlot(session: MainlineReconcileSession): Promise<void> {
    const state = readState(session.id);
    if (!state) return;
    if (state.slot.phase === 'idle') {
      if (state.restartOwed) requestRestart(session, state.restartOwed);
      return;
    }
    let slot: MainlineSlot | null = state.slot;
    if (slot.phase === 'pushing') slot = sweepStrandedPush(session, slot, state.branch);
    if (!slot || slot.phase !== 'uncertain' || !slot.attemptId || !slot.sha) return;

    const key = `${session.id}:${slot.attemptId}`;
    const wait = backoffs.get(key);
    if (wait && now() < wait.nextAt) return;

    const answer = await askRemote(session, slot, state.branch);
    if (answer.kind === 'unknown') {
      noteUnknown(session, slot, state.branch, key, answer.detail);
      return;
    }

    const write = transitionMainlineSlot({
      stmts: deps.stmts,
      sessionId: session.id,
      expect: { phase: 'uncertain', attemptId: slot.attemptId },
      event: { type: answer.kind === 'present' ? 'remote_present' : 'remote_absent' },
      nowIso: nowIso(),
    });
    if (!write.wrote) {
      if (write.reason === 'stale') {
        // Another writer settled this attempt; the answer is for a state that is gone.
        backoffs.delete(key);
        return;
      }
      noteUnknown(
        session,
        slot,
        state.branch,
        key,
        `the remote answered ${answer.kind} but the slot write was refused (${write.reason})`,
      );
      return;
    }
    backoffs.delete(key);
    const branch = state.branch as string;
    if (answer.kind === 'present') {
      deps.postNotice(
        session.id,
        `Autopilot confirmed ${shortSha(slot.sha)} is on ${branch} after an uncertain push. The deploy runs next.`,
      );
      return;
    }
    deps.postNotice(
      session.id,
      `Autopilot confirmed ${shortSha(slot.sha)} did not reach ${branch}. Finalize runs again to push it.`,
    );
    const owed = readState(session.id)?.restartOwed;
    if (owed) requestRestart(session, owed);
  }

  function restartKey(sessionId: string, attemptId: string): string {
    return `restart:${sessionId}:${attemptId}`;
  }

  /**
   * Ask Finalize to restart for an owed attempt, unless one request is
   * already in flight or the backoff has not elapsed. Not awaited by the
   * sweep: a kickoff can wait on the worktree lock, and deploys for other
   * sessions must not queue behind it.
   */
  function requestRestart(session: MainlineReconcileSession, owed: MainlineRestartOwed): void {
    const key = restartKey(session.id, owed.attemptId);
    if (pendingRestarts.has(key)) return;
    const wait = backoffs.get(key);
    if (wait && now() < wait.nextAt) return;
    const run = (async () => {
      let result: MainlineRestartResult;
      try {
        result = await deps.restartFinalize(session.id);
      } catch (err) {
        result = { kind: 'retry', detail: `restart threw: ${errMessage(err)}` };
      }
      settleRestart(session, owed, key, result);
    })()
      .catch((err) =>
        log(
          `[autopilot-reconcile] session=${session.id} restart settle failed: ${errMessage(err)}`,
        ),
      )
      .finally(() => pendingRestarts.delete(key));
    pendingRestarts.set(key, run);
  }

  function settleRestart(
    session: MainlineReconcileSession,
    owed: MainlineRestartOwed,
    key: string,
    result: MainlineRestartResult,
  ): void {
    if (result.kind === 'retry') {
      const failures = (backoffs.get(key)?.failures ?? 0) + 1;
      const delay = mainlineReconcileBackoffMs(failures);
      backoffs.set(key, { failures, nextAt: now() + delay });
      log(
        `[autopilot-reconcile] session=${session.id} attempt=${owed.attemptId} Finalize restart ` +
          `failed (attempt ${failures}, retry in ${Math.round(delay / 1000)}s): ${result.detail}`,
      );
      return;
    }
    backoffs.delete(key);
    const cleared = clearMainlineRestartOwed({
      stmts: deps.stmts,
      sessionId: session.id,
      attemptId: owed.attemptId,
    });
    if (result.kind === 'dropped') {
      log(
        `[autopilot-reconcile] session=${session.id} attempt=${owed.attemptId} Finalize restart ` +
          `dropped: ${result.detail}`,
      );
      if (cleared) {
        deps.postNotice(
          session.id,
          `Autopilot did not restart Finalize for ${shortSha(owed.sha)}: ${result.detail}`,
        );
      }
    }
  }

  return {
    reconcile,
    /** Test seam: resolves once every in-flight restart request has settled. */
    async settled(): Promise<void> {
      while (pendingRestarts.size) await Promise.all([...pendingRestarts.values()]);
    },
    /** Test seam: in-memory backoff for `sessionId:attemptId`. */
    backoffFor(key: string): Backoff | undefined {
      return backoffs.get(key);
    },
  };
}

export type MainlineReconciler = ReturnType<typeof createMainlineReconciler>;
