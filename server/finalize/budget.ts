/**
 * budget.ts — Finalize Code Changes, active-time budget accounting.
 *
 * Single source of truth for the §13 active-time budget contract
 * (4-hour hard ceiling at v0). The orchestrator and every phase module
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
 *   - Hard ceiling 4 hours at v0. `timeout_minutes` in ci.yaml may
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
import { classifyFailureReason } from './infra-retry.js';

/** Hard ceiling on the active-time budget (seconds). 4 hours at v0. */
export const FINALIZE_BUDGET_HARD_CEILING_SECONDS = 4 * 60 * 60;

/**
 * Default budget when ci.yaml is silent on `timeout_minutes`. Matches
 * the hard ceiling at v0; we keep them as two constants so a future
 * "default is lower than ceiling" split is a one-line change.
 */
export const FINALIZE_BUDGET_DEFAULT_SECONDS = 4 * 60 * 60;

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
 *   - Positive integer ≤ ceiling minutes → that many minutes, in seconds.
 *   - Positive integer above the ceiling → clamped down (the ci.yaml
 *     parser already rejects this at parse time; the clamp is defense-in-depth).
 *   - Non-positive or non-finite → default budget (also pre-validated;
 *     defensive fallback).
 */
export function resolveBudgetSeconds(args: {
  /** ci.yaml's `timeout_minutes`. The parser clamps to [1, ceiling minutes]. */
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
 * Hard ceiling on the `retry_of_run_id` chain walk — bounds the lookup
 * against a cyclic / corrupt column. Generation caps keep real chains short.
 */
const MAX_BUDGET_CHAIN_WALK = 32;

/**
 * Sum the active seconds the current run's family has spent against the shared
 * cap. The §13 contract: "the cap is shared across the original run and its
 * infra retries — a retry does NOT get a fresh budget."
 *
 * **Reclaim/infra-wasted time is non-billable.** An ancestor exists in the
 * chain only because it failed with an infra-class reason (a Spot reclaim or
 * other environment loss). That attempt restarted the job from scratch through
 * no fault of the change set, so charging its consumed seconds to the shared
 * budget would let back-to-back reclaims trip the CI-class `timeout` and read
 * as a code failure. We therefore EXCLUDE any *ancestor* whose `failure_reason`
 * classifies as infra. The run being queried always counts its own seconds —
 * only upstream infra-aborted attempts are forgiven.
 *
 * Walks the full chain (depth-bounded) rather than a single link, since the
 * generation-aware retry policy can now produce a chain longer than one.
 */
export function getRunFamilyActiveSeconds(
  stmts: Pick<BudgetStmts, 'getFinalizeRun'>,
  runId: string,
): number {
  const row = stmts.getFinalizeRun.get(runId) as FinalizeRunRow | undefined;
  if (!row) return 0;
  // The queried run's own time always counts.
  let total = row.active_seconds_consumed ?? 0;
  let cursor: string | null = row.retry_of_run_id ?? null;
  const seen = new Set<string>([runId]);
  for (let i = 0; i < MAX_BUDGET_CHAIN_WALK && cursor; i++) {
    if (seen.has(cursor)) break; // cycle guard
    seen.add(cursor);
    const ancestor = stmts.getFinalizeRun.get(cursor) as FinalizeRunRow | undefined;
    if (!ancestor) break;
    // Forgive an ancestor's seconds when it ended in an infra-class failure
    // (the only reason a retry of it exists): that compute was reclaim/infra
    // waste, not budget the change set should pay for.
    if (classifyFailureReason(ancestor.failure_reason) !== 'infra') {
      total += ancestor.active_seconds_consumed ?? 0;
    }
    cursor = ancestor.retry_of_run_id ?? null;
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
 * Header used when a CI **step / pipeline** ran past the per-run
 * `timeout_minutes` wall-clock cap and was stopped — distinct from the
 * §13 active-time budget header above.
 *
 * Why the split: the active-time budget meters total Hub processing
 * (rebase + reviewer + agent turns), whereas a step timeout means a
 * single test/build step hung or ran too slow against the pipeline
 * wall-clock cap. Surfacing a step timeout with the active-budget header
 * is actively misleading: it reads "Budget: 3600s. Consumed: 96s." —
 * making it look like the run stopped despite barely using its budget,
 * because step execution wall-clock bills only a flat tick to active
 * time. The two outcomes deserve two different messages.
 */
export const STEP_TIMEOUT_DISPATCH_HEADER =
  'Finalize Code Changes: timed out — a CI step exceeded the pipeline timeout.';

/** Which clock tripped: the §13 active-time budget or a pipeline-step wall-clock cap. */
export type FinalizeTimeoutClass = 'active_budget' | 'pipeline_step';

/**
 * Compose the body of the timeout message dropped into the session.
 * Pure — exposed for tests and the orchestrator. Mirrors the wording
 * of the §7 fix-dispatch message so the UI / agent can identify the
 * structured handoff.
 *
 * `timeoutClass` selects which clock tripped:
 *   - `'active_budget'` (default) → the §13 active-time budget exhausted;
 *     surfaced with the budget/consumed summary.
 *   - `'pipeline_step'` → a single CI step ran past the per-run
 *     `timeout_minutes` wall-clock cap; surfaced with the step-timeout
 *     header and the pipeline timeout (NOT the active-time budget, which
 *     was not exhausted).
 */
export function composeTimeoutMessageBody(args: {
  timeoutClass?: FinalizeTimeoutClass;
  budgetSeconds: number;
  activeSecondsConsumed: number;
  /** Pipeline wall-clock cap (`timeout_minutes`); used for the `pipeline_step` summary. */
  timeoutMinutes?: number;
  lastOutputTail?: string[];
  lastStepName?: string;
  lastStepExitCode?: number;
}): string {
  const timeoutClass: FinalizeTimeoutClass = args.timeoutClass ?? 'active_budget';
  const lines: string[] = [];
  if (timeoutClass === 'pipeline_step') {
    lines.push(STEP_TIMEOUT_DISPATCH_HEADER);
    lines.push('');
    lines.push(
      typeof args.timeoutMinutes === 'number' && Number.isFinite(args.timeoutMinutes)
        ? `Pipeline step timeout: ${args.timeoutMinutes}min. A step ran past the per-run wall-clock limit and was stopped.`
        : 'A CI step ran past the per-run wall-clock limit and was stopped.',
    );
  } else {
    lines.push(TIMEOUT_DISPATCH_HEADER);
    lines.push('');
    lines.push(
      `Budget: ${args.budgetSeconds}s (active time). Consumed: ${args.activeSecondsConsumed}s.`,
    );
  }
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
    /** Which clock tripped. Defaults to the §13 active-time budget. */
    timeoutClass?: FinalizeTimeoutClass;
    budgetSeconds: number;
    activeSecondsConsumed: number;
    /** Pipeline wall-clock cap (`timeout_minutes`); surfaced for `pipeline_step`. */
    timeoutMinutes?: number;
    lastOutputTail?: string[];
    lastStepName?: string;
    lastStepExitCode?: number;
  },
): { messageId: string } | null {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const newId = deps.newId ?? uuidv4;
  const timeoutClass: FinalizeTimeoutClass = args.timeoutClass ?? 'active_budget';
  const body = composeTimeoutMessageBody(args);
  const messageId = newId();
  const metadata = JSON.stringify({
    // Keep `kind` stable across both classes so existing consumers that
    // filter on `finalize_timeout_dispatch` still match; `timeoutClass`
    // disambiguates the active-time budget from a pipeline-step timeout.
    kind: 'finalize_timeout_dispatch',
    timeoutClass,
    runId: args.runId,
    cardId: args.cardId,
    projectId: args.projectId,
    budgetSeconds: args.budgetSeconds,
    activeSecondsConsumed: args.activeSecondsConsumed,
    timeoutMinutes: args.timeoutMinutes ?? null,
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
