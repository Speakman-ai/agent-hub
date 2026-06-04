/**
 * boot-recovery.ts — fail in-flight Finalize runs on Hub boot.
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
 */
import type { Stmts } from './../types.js';

export function failStuckFinalizeRunsOnBoot(stmts: Stmts): void {
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
      console.warn(`[finalize] Marked ${steps.changes} orphaned finalize step(s) as skipped on boot`);
    }
  } catch (e) {
    console.error('[finalize] failStuckActiveFinalizeRunStepsOnBoot', (e as Error).message);
  }
}
