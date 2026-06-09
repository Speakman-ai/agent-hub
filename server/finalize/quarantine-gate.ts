/**
 * quarantine-gate.ts — orchestrator-side glue for cross-run flake history +
 * the quarantine lane. Keeps the DB fan-out out of orchestrator.ts.
 *
 *   1. {@link recordRunTestHistory} — once per loop_round (right after the
 *      attempt snapshot), collapse the run's recorded per-round attempts into
 *      one cross-run history row per job instance (`finalize_test_history`).
 *      Idempotent upsert keyed on (run_id, job_id, matrix_key), so calling it
 *      every round just refreshes the row; the final call reflects the run's
 *      ultimate per-instance outcome regardless of which terminal path the run
 *      takes. This is the dataset {@link computeFlakeRate} reads.
 *
 *   2. {@link loadActiveQuarantine} — load a project's quarantine entries as
 *      normalised {@link QuarantineEntry} objects so the orchestrator can call
 *      the pure {@link applyQuarantineToGate} at the push gate.
 *
 * The pure decisions live in flake-history.ts / quarantine.ts; this module
 * only moves rows. Non-throwing on the record path so it can't crash the loop.
 */

import type { FinalizeQuarantineRow, FinalizeRunJobAttemptRow, Stmts } from '../types.js';
import { deriveRunInstanceOutcomes } from './flake-history.js';
import type { JobRoundAttempt } from './flake-recovery.js';
import type { QuarantineEntry } from './quarantine.js';

/**
 * Snapshot the run's collapsed per-instance outcomes into
 * `finalize_test_history`. Reads the per-round attempts the flake gate already
 * persisted, derives final-state + in-run-flake per instance, and upserts one
 * row per instance.
 *
 * Best-effort: returns the number of rows written, swallows + logs failures
 * (a missing history row only degrades future flake-rate accuracy, it never
 * affects the gate's fail-closed correctness). Never throws.
 */
export function recordRunTestHistory(
  deps: {
    stmts: Pick<Stmts, 'listFinalizeRunJobAttemptsForRun' | 'upsertFinalizeTestHistory'>;
    now?: () => number;
    log?: (msg: string) => void;
  },
  args: { runId: string; projectId: string; branch: string | null; headSha: string | null },
): number {
  const now = deps.now ?? Date.now;
  let rows: FinalizeRunJobAttemptRow[];
  try {
    rows = deps.stmts.listFinalizeRunJobAttemptsForRun.all(
      args.runId,
    ) as FinalizeRunJobAttemptRow[];
  } catch (err) {
    deps.log?.(
      `[finalize-quarantine-gate] listFinalizeRunJobAttemptsForRun failed run=${args.runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 0;
  }
  if (rows.length === 0) return 0;

  const attempts: JobRoundAttempt[] = rows.map((r) => ({
    jobId: r.job_id,
    matrixKey: r.matrix_key,
    round: r.round,
    state: r.state,
    headSha: r.head_sha,
  }));
  const outcomes = deriveRunInstanceOutcomes(attempts);
  const recordedAt = now();
  let written = 0;
  for (const o of outcomes) {
    try {
      deps.stmts.upsertFinalizeTestHistory.run(
        args.runId,
        args.projectId,
        o.jobId,
        o.matrixKey,
        args.branch,
        args.headSha,
        o.finalState,
        o.flaked ? 1 : 0,
        recordedAt,
      );
      written += 1;
    } catch (err) {
      deps.log?.(
        `[finalize-quarantine-gate] upsertFinalizeTestHistory failed run=${args.runId} ` +
          `job=${o.jobId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return written;
}

/** Normalise a `finalize_quarantine` row into a pure {@link QuarantineEntry}. */
export function quarantineRowToEntry(row: FinalizeQuarantineRow): QuarantineEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    matrixKey: row.matrix_key,
    owner: row.owner,
    reason: row.reason,
    quarantinedAt: row.quarantined_at,
    expiresAt: row.expires_at,
    createdBy: row.created_by,
  };
}

/**
 * Load a project's quarantine entries as normalised {@link QuarantineEntry}
 * objects. Returns `[]` (never throws) on a query failure — an unreadable
 * quarantine list means the gate excuses nothing, which is the safe direction
 * (a genuine flake stays blocked rather than being silently excused).
 */
export function loadActiveQuarantine(
  deps: {
    stmts: Pick<Stmts, 'listFinalizeQuarantineForProject'>;
    log?: (msg: string) => void;
  },
  projectId: string,
): QuarantineEntry[] {
  try {
    const rows = deps.stmts.listFinalizeQuarantineForProject.all(
      projectId,
    ) as FinalizeQuarantineRow[];
    return rows.map(quarantineRowToEntry);
  } catch (err) {
    deps.log?.(
      `[finalize-quarantine-gate] listFinalizeQuarantineForProject failed project=${projectId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}
