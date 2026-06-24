/**
 * reconcile-terminal-steps.ts — make a Finalize run's per-step rows consistent
 * with the run reaching a terminal status.
 *
 * Two persisted-state gaps make a terminally-FAILED run look like it is still
 * running (the recurring "appears to be running but has failed" report):
 *
 *   1. **Orphaned step rows.** The v2 matrix path shares `runStepsSequence`,
 *      and the FIRST shard to fail writes the run-level terminal
 *      (`failFinalizeRun('failed','step_failed')`) + stamps `ended_at` while
 *      sibling shards are still queued/running. Those siblings' step rows are
 *      then left non-terminal forever (the orchestrator reached its true
 *      terminal, or the Hub crashed, before they finished), so the
 *      Runners/checks panel shows them `queued`/`running` indefinitely.
 *   2. **Missing failed-step summary.** `failFinalizeRun` records status +
 *      failure_reason + ended_at but NOT which step failed, so the run row's
 *      `failed_step_index/name/exit_code` stay NULL and any surface that names
 *      the failing step from the run row renders "failed" with nothing to
 *      point at.
 *
 * `reconcileFinalizeRunTerminalSteps` closes both gaps at the moment the run
 * goes terminal: it backfills the run-row failed-step summary from the first
 * `failed` step (when NULL), then sweeps every still-in-flight step row to a
 * terminal `skipped` state and broadcasts a `finalize_run_step_state` event per
 * swept step so live clients converge without a refetch.
 *
 * The helper is deliberately best-effort and idempotent — a second call (e.g.
 * boot-recovery after an in-process reconcile already ran) is a no-op because
 * the DB guards (`failed_step_index IS NULL`, `state IN ('queued','running')`)
 * match zero rows the second time. It must never throw into a terminal path:
 * the run is already over, and a bookkeeping hiccup must not mask the failure.
 */
import type { BroadcastFn, FinalizeRunStepRow, Stmts } from '../types.js';

export interface ReconcileTerminalStepsDeps {
  stmts: Pick<
    Stmts,
    | 'listFinalizeRunStepsForRun'
    | 'markFinalizeRunStepSkippedIfPending'
    | 'backfillFinalizeRunFailedStep'
  >;
  broadcast: BroadcastFn;
}

export interface ReconcileTerminalStepsResult {
  /** step_index values swept from queued/running → skipped. */
  sweptStepIndexes: number[];
  /** The failed-step summary backfilled onto the run row, if any. */
  backfilledFailedStep: { index: number; name: string; exitCode: number | null } | null;
}

const NON_TERMINAL_STATES = new Set(['queued', 'running']);

/**
 * Reconcile a terminal run's step rows. Safe to call on any run id (including
 * one with no step rows, or one already fully reconciled): it only mutates
 * non-terminal step rows and a NULL failed-step summary.
 *
 * @param sessionId carried into the broadcast so session-scoped subscribers
 *   (the checks panel) match the event; may be null for ad-hoc runs.
 */
export function reconcileFinalizeRunTerminalSteps(
  deps: ReconcileTerminalStepsDeps,
  runId: string,
  sessionId: string | null,
): ReconcileTerminalStepsResult {
  const result: ReconcileTerminalStepsResult = {
    sweptStepIndexes: [],
    backfilledFailedStep: null,
  };

  let steps: FinalizeRunStepRow[];
  try {
    steps = deps.stmts.listFinalizeRunStepsForRun.all(runId) as FinalizeRunStepRow[];
  } catch (err) {
    console.warn(
      `[finalize-reconcile] listFinalizeRunStepsForRun failed run=${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return result;
  }

  // 1) Backfill the run-row failed-step summary from the first failed step.
  //    `find` over the index-ordered rows yields the lowest step_index, which
  //    is the first step to fail in declaration order.
  const firstFailed = steps.find((s) => s.state === 'failed');
  if (firstFailed) {
    try {
      const res = deps.stmts.backfillFinalizeRunFailedStep.run(
        firstFailed.step_index,
        firstFailed.name,
        firstFailed.exit_code,
        runId,
      ) as { changes: number };
      if (res.changes > 0) {
        result.backfilledFailedStep = {
          index: firstFailed.step_index,
          name: firstFailed.name,
          exitCode: firstFailed.exit_code,
        };
      }
    } catch (err) {
      console.warn(
        `[finalize-reconcile] backfillFinalizeRunFailedStep failed run=${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // 2) Sweep still-in-flight step rows to terminal `skipped` + broadcast each.
  for (const step of steps) {
    if (!NON_TERMINAL_STATES.has(step.state)) continue;
    let changed = false;
    try {
      const res = deps.stmts.markFinalizeRunStepSkippedIfPending.run(runId, step.step_index) as {
        changes: number;
      };
      changed = res.changes > 0;
    } catch (err) {
      console.warn(
        `[finalize-reconcile] markFinalizeRunStepSkippedIfPending failed run=${runId} step=${step.step_index}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    if (!changed) continue;
    result.sweptStepIndexes.push(step.step_index);
    try {
      deps.broadcast({
        type: 'finalize_run_step_state',
        run_id: runId,
        ...(sessionId ? { session_id: sessionId } : {}),
        step_index: step.step_index,
        step_name: step.name,
        state: 'skipped',
        ...(step.job_id ? { job_id: step.job_id } : {}),
        ...(step.matrix_key ? { matrix_key: step.matrix_key } : {}),
      });
    } catch (err) {
      console.warn(
        `[finalize-reconcile] step-skip broadcast failed run=${runId} step=${step.step_index}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return result;
}
