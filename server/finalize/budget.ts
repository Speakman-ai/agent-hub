/**
 * budget.ts — Finalize Code Changes, active-time budget accounting.
 *
 * Single source of truth for the §13 "60-min Agent Hub active time"
 * contract. The orchestrator and every phase module reach into this
 * module rather than each carrying its own copy of the rules so the
 * contract cannot drift across phases.
 *
 * Why active-time, not wall-clock (§13):
 *
 *   The fix-dispatch loop runs through the **originating session**
 *   (human-in-the-loop in live mode, autonomous loop in agent mode).
 *   Wall-clock would punish runs for human latency or for the
 *   autonomous loop sleeping between agent turns. Active time charges
 *   only for the seconds Agent Hub spends actually processing the run.
 *
 *   - Active = orchestrator phases (rebase, parse, push) + reviewer
 *     agent turn duration + step execution + originating-session turn
 *     duration on Finalize-dispatched messages.
 *   - Clock pauses when waiting on a session queue or on a turn-end
 *     signal that has not yet arrived.
 *
 * Cap rules (§13):
 *
 *   - Hard ceiling 60 minutes at v0. `timeout_minutes` in ci.yaml may
 *     lower the cap (e.g. fast-fail at 10 min) but cannot raise it.
 *   - The cap is **shared across the original run and its one infra
 *     retry**. The retry does NOT get a fresh budget — see
 *     {@link getRunFamilyActiveSeconds}.
 *   - Timeout is a CI-class outcome (`status = 'timed_out'`), not an
 *     infra failure. The orchestrator surfaces it with the last-attempt
 *     output tail injected into the session via {@link postTimeoutDispatchMessage}.
 *
 * Implementation note: every phase module calls
 * {@link stmts.updateFinalizeRunActiveSeconds} directly for the write,
 * and the orchestrator emits `finalize_run_active_seconds` via
 * {@link broadcastActiveSeconds} after each phase or per-turn bill so
 * subscribers see the running total. Splitting the write from the
 * broadcast keeps phase modules dep-light (they don't need
 * `BroadcastFn`) while still surfacing the count to the UI.
 */
import { v4 as uuidv4 } from 'uuid';
import type { BroadcastFn, FinalizeRunRow, FinalizeRunStatus, Stmts } from '../types.js';

/**
 * Hard ceiling on the active-time budget (seconds). 60 minutes at v0.
 * `timeout_minutes` in ci.yaml may LOWER the cap but never raise it.
 *
 * Exported so callers (orchestrator, tests, future ci.yaml validators)
 * share the same number — there is no other place this constant should
 * be redeclared.
 */
export const FINALIZE_BUDGET_HARD_CEILING_SECONDS = 60 * 60;

/**
 * Default budget when ci.yaml is silent on `timeout_minutes`. Matches
 * the hard ceiling at v0; we keep them as two constants so a future
 * "default is 30 min, ceiling is 60" split is a one-line change.
 */
export const FINALIZE_BUDGET_DEFAULT_SECONDS = 60 * 60;

/**
 * Terminal statuses on `finalize_runs`. The "active run for a session"
 * lookup excludes these — a row in any other status is considered
 * in-flight and the session's turn-ends should bill to it.
 *
 * Mirrors {@link FinalizeRunStatus}; if a new status lands, update both
 * here and the SQL `NOT IN (...)` literal in db.ts.
 */
export const FINALIZE_TERMINAL_STATUSES: ReadonlyArray<FinalizeRunStatus> = [
  'pushed',
  'failed',
  'timed_out',
  'infra_error',
  'cancelled',
  'stalled_no_response',
];

/**
 * Compute the effective budget for a run given ci.yaml's optional
 * `timeout_minutes`. Clamps to {@link FINALIZE_BUDGET_HARD_CEILING_SECONDS}
 * — the hard ceiling is the only thing this function will not let you
 * exceed.
 *
 *   - `null` / `undefined` → default budget (hard ceiling at v0).
 *   - Positive integer ≤ 60 → that many minutes, in seconds.
 *   - Positive integer > 60 → clamped down to 60 (the ci.yaml parser
 *     already rejects this at parse time; the clamp is defense-in-depth).
 *   - Non-positive or non-finite → default budget (also pre-validated;
 *     defensive fallback).
 */
export function resolveBudgetSeconds(args: {
  /** ci.yaml's `timeout_minutes`. The parser clamps to [1, 60]. */
  ciTimeoutMinutes?: number | null;
}): number {
  const raw = args.ciTimeoutMinutes;
  if (raw == null || !Number.isFinite(raw) || raw <= 0) {
    return FINALIZE_BUDGET_DEFAULT_SECONDS;
  }
  const seconds = Math.floor(raw) * 60;
  return Math.min(FINALIZE_BUDGET_HARD_CEILING_SECONDS, seconds);
}

/**
 * Statements the budget module needs. A subset of {@link Stmts} so
 * callers can pass narrow dep bundles.
 */
export type BudgetStmts = Pick<
  Stmts,
  | 'getFinalizeRun'
  | 'updateFinalizeRunActiveSeconds'
  | 'getActiveFinalizeRunForSession'
  | 'addMessage'
  | 'touchSession'
  | 'getMessageById'
>;

/**
 * Increment `finalize_runs.active_seconds_consumed` and broadcast a
 * `finalize_run_active_seconds` event with the new total. The broadcast
 * uses the running total (not the delta) because subscribers care about
 * "how close are we to the cap", not "what was just added".
 *
 * Non-throwing: a DB or broadcast failure is logged via the optional
 * `log` sink and swallowed. The orchestrator's terminal path does its
 * own re-check via {@link isBudgetExhausted} so a missed write never
 * skips the budget guard.
 */
export function billActiveSeconds(
  deps: {
    stmts: Pick<BudgetStmts, 'updateFinalizeRunActiveSeconds' | 'getFinalizeRun'>;
    broadcast: BroadcastFn;
    log?: (msg: string) => void;
  },
  runId: string,
  seconds: number,
): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  const rounded = Math.max(1, Math.floor(seconds));
  try {
    deps.stmts.updateFinalizeRunActiveSeconds.run(rounded, runId);
  } catch (err) {
    log(
      `[finalize-budget] updateFinalizeRunActiveSeconds failed for run=${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  broadcastActiveSeconds(deps, runId);
}

/**
 * Read the current total and broadcast `finalize_run_active_seconds`.
 * Exposed so callers that bill via a different code path (e.g. a phase
 * module that has its own `updateFinalizeRunActiveSeconds` call but
 * wants the broadcast to fire centrally) can still emit the event.
 */
export function broadcastActiveSeconds(
  deps: {
    stmts: Pick<BudgetStmts, 'getFinalizeRun'>;
    broadcast: BroadcastFn;
    log?: (msg: string) => void;
  },
  runId: string,
): void {
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  let total = 0;
  try {
    const row = deps.stmts.getFinalizeRun.get(runId) as FinalizeRunRow | undefined;
    if (!row) return;
    total = row.active_seconds_consumed ?? 0;
  } catch (err) {
    log(
      `[finalize-budget] getFinalizeRun failed for run=${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  try {
    deps.broadcast({
      type: 'finalize_run_active_seconds',
      run_id: runId,
      active_seconds_consumed: total,
    });
  } catch (err) {
    log(
      `[finalize-budget] broadcast failed for run=${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Sum the active seconds for a run and its retry parent (if any). The
 * §13 contract is explicit: "the cap is shared across the original run
 * and its one infra retry — the retry does NOT get a fresh budget."
 *
 * Walks at most ONE link via `retry_of_run_id`. There is no transitive
 * chain at v0; a retry of a retry is not a v0 surface, but if the column
 * ever points at a chain we still cap the walk to keep the lookup O(1).
 */
export function getRunFamilyActiveSeconds(
  stmts: Pick<BudgetStmts, 'getFinalizeRun'>,
  runId: string,
): number {
  const row = stmts.getFinalizeRun.get(runId) as FinalizeRunRow | undefined;
  if (!row) return 0;
  let total = row.active_seconds_consumed ?? 0;
  if (row.retry_of_run_id) {
    const parent = stmts.getFinalizeRun.get(row.retry_of_run_id) as FinalizeRunRow | undefined;
    if (parent) {
      total += parent.active_seconds_consumed ?? 0;
    }
  }
  return total;
}

/**
 * Has the run's family (run + retry parent) exhausted its budget?
 *
 * Always uses the family total — a retry that starts with its parent
 * already at 55 minutes only gets 5 minutes of its own before tripping.
 */
export function isBudgetExhausted(
  stmts: Pick<BudgetStmts, 'getFinalizeRun'>,
  runId: string,
  budgetSeconds: number,
  log?: (msg: string) => void,
): boolean {
  try {
    return getRunFamilyActiveSeconds(stmts, runId) >= budgetSeconds;
  } catch (err) {
    (log ?? ((m: string) => console.warn(m)))(
      `[finalize-budget] family-total read failed for run=${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * Find the in-flight finalize run that a session is currently driving,
 * if any. Used by the chat.ts session turn-end hook so a turn that
 * finishes on a session bound to an active Finalize run bills its
 * duration to that run.
 *
 * Returns `null` when:
 *   - the session has no `finalize_runs` row, OR
 *   - every row for the session is in a terminal status.
 */
export function getActiveFinalizeRunForSession(
  stmts: Pick<BudgetStmts, 'getActiveFinalizeRunForSession'>,
  sessionId: string,
): FinalizeRunRow | null {
  try {
    const row = stmts.getActiveFinalizeRunForSession.get(sessionId) as FinalizeRunRow | undefined;
    return row ?? null;
  } catch {
    // The statement may not exist on older test wirings — never throw
    // out of this hook because the chat.ts call-site cannot recover.
    return null;
  }
}

/**
 * Session-turn-end hook called from chat.ts after the `done` broadcast
 * fires. If the session has an active Finalize run, bill the turn's
 * wall-clock duration to that run via {@link billActiveSeconds}.
 *
 * The duration billed is the actual turn time the agent spent
 * processing — chat.ts already tracks this as
 * `Date.now() - cliTurnStartMs`. Sub-second turns are floored to 1 so
 * a fast no-op turn still counts as a tick against the budget.
 *
 * No-op when there is no active run, the duration is non-positive, or
 * the lookup fails — the chat path must never throw out of this hook.
 */
export function billSessionTurnDurationIfTaggedToFinalize(
  deps: {
    stmts: Pick<
      BudgetStmts,
      'getActiveFinalizeRunForSession' | 'updateFinalizeRunActiveSeconds' | 'getFinalizeRun'
    >;
    broadcast: BroadcastFn;
    log?: (msg: string) => void;
  },
  sessionId: string,
  durationMs: number,
): { runId: string; secondsBilled: number } | null {
  if (!sessionId) return null;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const run = getActiveFinalizeRunForSession(deps.stmts, sessionId);
  if (!run) return null;
  const seconds = Math.max(1, Math.floor(durationMs / 1000));
  billActiveSeconds(deps, run.id, seconds);
  return { runId: run.id, secondsBilled: seconds };
}

/**
 * Header on the system message posted into the originating session
 * when a run trips the active-time budget. Locked to a constant so
 * tests and UI grep can identify the message.
 */
export const TIMEOUT_DISPATCH_HEADER =
  'Finalize Code Changes: timed out — active-time budget exhausted.';

/**
 * Compose the body of the timeout message dropped into the session.
 * Pure — exposed for tests and the orchestrator. Mirrors the wording
 * of the §7 fix-dispatch message so the UI / agent can identify the
 * structured handoff.
 */
export function composeTimeoutMessageBody(args: {
  budgetSeconds: number;
  activeSecondsConsumed: number;
  lastOutputTail?: string[];
  lastStepName?: string;
  lastStepExitCode?: number;
}): string {
  const lines: string[] = [];
  lines.push(TIMEOUT_DISPATCH_HEADER);
  lines.push('');
  lines.push(
    `Budget: ${args.budgetSeconds}s (active time). Consumed: ${args.activeSecondsConsumed}s.`,
  );
  if (args.lastStepName) {
    const ec = args.lastStepExitCode ?? null;
    lines.push(`Last attempted step: "${args.lastStepName}"${ec !== null ? ` (exit ${ec})` : ''}.`);
  }
  if (args.lastOutputTail && args.lastOutputTail.length > 0) {
    lines.push('');
    lines.push(`Last output (${args.lastOutputTail.length} lines):`);
    for (const line of args.lastOutputTail) lines.push(line);
  }
  lines.push('');
  lines.push(
    'The run has been parked. Re-trigger Finalize Code Changes when the work is ready to retry.',
  );
  return lines.join('\n');
}

/**
 * Post the §13 timeout message into the originating session. Best-
 * effort — a DB or broadcast failure is logged and swallowed so the
 * orchestrator's terminal path can still complete cleanly. The session
 * keeps its worktree (the session owns the worktree; the orchestrator
 * never touches it on terminal).
 */
export function postTimeoutDispatchMessage(
  deps: {
    stmts: Pick<BudgetStmts, 'addMessage' | 'touchSession' | 'getMessageById'>;
    broadcast: BroadcastFn;
    log?: (msg: string) => void;
    newId?: () => string;
  },
  args: {
    runId: string;
    sessionId: string;
    cardId: string;
    projectId: string;
    budgetSeconds: number;
    activeSecondsConsumed: number;
    lastOutputTail?: string[];
    lastStepName?: string;
    lastStepExitCode?: number;
  },
): { messageId: string } | null {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const newId = deps.newId ?? uuidv4;
  const body = composeTimeoutMessageBody(args);
  const messageId = newId();
  const metadata = JSON.stringify({
    kind: 'finalize_timeout_dispatch',
    runId: args.runId,
    cardId: args.cardId,
    projectId: args.projectId,
    budgetSeconds: args.budgetSeconds,
    activeSecondsConsumed: args.activeSecondsConsumed,
    lastStepName: args.lastStepName ?? null,
    lastStepExitCode: args.lastStepExitCode ?? null,
  });
  try {
    deps.stmts.addMessage.run(
      messageId,
      args.sessionId,
      'system',
      body,
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
      `[finalize-budget] timeout message insert failed for run=${args.runId} session=${args.sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  try {
    deps.stmts.touchSession.run(args.sessionId);
  } catch {
    /* best-effort */
  }
  try {
    const inserted = deps.stmts.getMessageById.get(messageId) as
      | { id: string; session_id: string }
      | undefined;
    if (inserted) {
      deps.broadcast({ type: 'message', sessionId: args.sessionId, message: inserted });
    }
  } catch (err) {
    log(
      `[finalize-budget] timeout message broadcast failed for run=${args.runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return { messageId };
}

export const __test = {
  FINALIZE_TERMINAL_STATUSES,
  FINALIZE_BUDGET_HARD_CEILING_SECONDS,
  FINALIZE_BUDGET_DEFAULT_SECONDS,
};
