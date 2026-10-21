/**
 * The single definition of which Finalize run statuses are terminal.
 *
 * Kept dependency-free so `db.ts` can interpolate the SQL fragments into its
 * prepared statements. Every hand-copied list drifts eventually: push-CI's
 * `succeeded` was missing from the boot sweep, so each Hub restart rewrote
 * every green default-branch run to `infra_error` ("interrupted").
 */
import type { FinalizeRunStatus } from '../types.js';

/** Statuses after which a run never changes again. */
export const FINALIZE_TERMINAL_STATUSES: ReadonlyArray<FinalizeRunStatus> = [
  'pushed',
  'succeeded',
  'failed',
  'timed_out',
  'infra_error',
  'cancelled',
  'stalled_no_response',
  'disputed',
];

function sqlList(statuses: ReadonlyArray<string>): string {
  return `(${statuses.map((s) => `'${s}'`).join(', ')})`;
}

/** `NOT IN` operand matching only terminal runs (parked `ready_to_push` counts as open). */
export const FINALIZE_TERMINAL_STATUSES_SQL = sqlList(FINALIZE_TERMINAL_STATUSES);

/**
 * Terminal statuses plus the parked `ready_to_push`, for queries that want runs
 * with a live orchestrator (boot sweep, billing, branch-scoped active run).
 */
export const FINALIZE_SETTLED_STATUSES_SQL = sqlList([
  ...FINALIZE_TERMINAL_STATUSES,
  'ready_to_push',
]);
