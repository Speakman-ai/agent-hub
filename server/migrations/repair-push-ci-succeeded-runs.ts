/**
 * One-shot repair of push-CI runs the boot sweep mislabeled.
 *
 * The boot sweep's terminal-status list was missing `succeeded`, the terminal
 * green status push-CI (trigger_source `git_push`) writes. Every Hub restart
 * therefore rewrote each green default-branch run to `infra_error` with
 * "Finalize run interrupted (server restart or crash)", keeping its original
 * `ended_at`. The sweep is fixed; this restores the rows it already rewrote.
 *
 * A row is restored only when the evidence says it finished green: it is a
 * `git_push` run carrying the exact sweep reason, has at least one job, every
 * job passed, and no step was left failed or swept to `skipped`. A run that
 * really was interrupted mid-flight has unfinished jobs and skipped steps.
 *
 * Guard: a marker file in the data dir makes this run once.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

export const PUSH_CI_SUCCEEDED_REPAIR_MARKER = '.push-ci-succeeded-repair.done';

const SWEEP_REASON = 'Finalize run interrupted (server restart or crash)';

export function repairPushCiSucceededRuns(opts: { db: BetterSqlite3.Database; dataDir: string }): {
  ran: boolean;
  restored: number;
} {
  const markerPath = path.join(opts.dataDir, PUSH_CI_SUCCEEDED_REPAIR_MARKER);
  if (existsSync(markerPath)) return { ran: false, restored: 0 };

  const result = opts.db
    .prepare(
      `UPDATE finalize_runs
          SET status = 'succeeded', failure_reason = NULL
        WHERE trigger_source = 'git_push'
          AND status = 'infra_error'
          AND failure_reason = @reason
          AND ended_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM finalize_run_jobs j WHERE j.run_id = finalize_runs.id)
          AND NOT EXISTS (
                SELECT 1 FROM finalize_run_jobs j
                 WHERE j.run_id = finalize_runs.id AND j.state <> 'passed'
              )
          AND NOT EXISTS (
                SELECT 1 FROM finalize_run_steps s
                 WHERE s.run_id = finalize_runs.id
                   AND s.state IN ('failed', 'skipped', 'queued', 'running')
              )`,
    )
    .run({ reason: SWEEP_REASON });

  try {
    mkdirSync(opts.dataDir, { recursive: true });
    writeFileSync(markerPath, new Date().toISOString());
  } catch {
    // Best-effort: a rerun only re-matches rows that still look mislabeled.
  }
  return { ran: true, restored: result.changes };
}
