/**
 * boot-recovery.ts — close out in-flight Finalize runs on Hub boot.
 *
 * A Finalize run's orchestrator loop and its remote-fleet streaming (the
 * per-job WebSocket handles + the in-process CancelSignal) live entirely in the
 * Hub process. When the Hub restarts or crashes mid-run, that state is gone but
 * the `finalize_runs` row is still non-terminal — so the UI shows the checks
 * "running" forever and the fleet jobs are orphaned (this is exactly what a
 * deploy-during-a-run caused).
 *
 * On boot, no run can have a live orchestrator yet, so every non-terminal run is
 * by definition orphaned. Mark them `infra_error` (a terminal status that the UI
 * already surfaces with a retrigger affordance) and their unfinished steps
 * `skipped`, so an interrupted run fails cleanly and immediately instead of
 * hanging. Mirrors `failStuckWorkflowRunsOnBoot` (server/workflow-runner.ts).
 *
 * Because the work product (the branch + its commits) is durable in git, the
 * interrupted runs are *also* snapshotted and returned so the caller can
 * re-trigger a fresh run per session — see `retriggerInterruptedFinalizeRunsOnBoot`
 * (boot-retrigger.ts). The snapshot is taken BEFORE the sweep, since the sweep
 * rewrites the same rows the predicate selects.
 */
import type { Stmts } from './../types.js';
import type { InterruptedFinalizeRun } from './boot-retrigger.js';

interface StuckFinalizeRunRow {
  id: string;
  session_id: string | null;
  card_id: string | null;
  project_id: string | null;
  head_sha: string | null;
}

/**
 * Sweep interrupted Finalize runs to `infra_error` and return the snapshot of
 * runs that are candidates for re-trigger (those with a session + card + head).
 */
export function failStuckFinalizeRunsOnBoot(stmts: Stmts): InterruptedFinalizeRun[] {
  let interrupted: InterruptedFinalizeRun[] = [];
  try {
    const rows = stmts.selectStuckActiveFinalizeRunsOnBoot.all() as StuckFinalizeRunRow[];
    interrupted = rows
      .filter((r) => r.session_id && r.card_id && r.project_id && r.head_sha)
      .map((r) => ({
        runId: r.id,
        sessionId: r.session_id as string,
        cardId: r.card_id as string,
        projectId: r.project_id as string,
        headSha: r.head_sha as string,
      }));
  } catch (e) {
    console.error('[finalize] selectStuckActiveFinalizeRunsOnBoot', (e as Error).message);
  }

  try {
    const runs = stmts.failStuckActiveFinalizeRunsOnBoot.run() as { changes: number };
    if (runs.changes > 0) {
      console.warn(
        `[finalize] Marked ${runs.changes} in-flight finalize run(s) as infra_error on boot (interrupted by restart/crash)`,
      );
    }
  } catch (e) {
    console.error('[finalize] failStuckActiveFinalizeRunsOnBoot', (e as Error).message);
  }
  try {
    const steps = stmts.failStuckActiveFinalizeRunStepsOnBoot.run() as { changes: number };
    if (steps.changes > 0) {
      console.warn(
        `[finalize] Marked ${steps.changes} orphaned finalize step(s) as skipped on boot`,
      );
    }
  } catch (e) {
    console.error('[finalize] failStuckActiveFinalizeRunStepsOnBoot', (e as Error).message);
  }

  // Backfill the failed-step summary for runs that went terminal-FAILED without
  // it. A v2 matrix shard marks the run `failed`/`step_failed` on the first
  // shard failure but never records WHICH step failed; if the Hub then crashed
  // before the in-process reconcile path ran, the run row's
  // `failed_step_index/name/exit_code` stay NULL and the UI can't name the
  // failing step. This catches that already-terminal class on boot (the
  // in-flight step sweep above already cleared their stranded sibling rows).
  try {
    const backfilled = stmts.backfillFinalizeRunFailedStepsOnBoot.run() as { changes: number };
    if (backfilled.changes > 0) {
      console.warn(
        `[finalize] Backfilled failed-step summary for ${backfilled.changes} terminal finalize run(s) on boot`,
      );
    }
  } catch (e) {
    console.error('[finalize] backfillFinalizeRunFailedStepsOnBoot', (e as Error).message);
  }

  return interrupted;
}
