/**
 * stuck-run-clock-sql.ts — the single definition of a Finalize run's progress
 * clock, shared by the two statements that must agree on it.
 *
 * WHY A SHARED FRAGMENT. The stuck-run reaper reads this expression twice: once
 * in the candidate SELECT (`selectRuntimeStuckFinalizeRunCandidates`) and again
 * in the atomic reap-guard (`failRuntimeStuckFinalizeRun`), which re-checks the
 * SAME idle predicate against current rows. If the two ever drift, the guard
 * stops mirroring the classifier and the TOCTOU protection silently weakens.
 * They used to be two hand-copied SQL strings, with a third copy pasted into the
 * tests — so the tests could (and did) keep passing against a stale expression.
 *
 * WHAT COUNTS AS PROGRESS. Every signal the orchestrator emits, not just step
 * rows:
 *   - `started_at` — floor, so a run with no other signal is still comparable;
 *   - `phase_changed_at` — the last phase/status write, i.e. the orchestrator
 *     proving liveness between phases;
 *   - step `started_at` / `ended_at` — step-level execution;
 *   - job `started_at` / `ended_at` — a runner claiming or finishing a job,
 *     which happens before its first step flips to `running`.
 *
 * The `phase_changed_at` and job terms are load-bearing, not belt-and-braces. A
 * run only reaches `status='running'` at the tasks phase, but its `started_at`
 * is stamped at INSERT — before rebase, review, and every fix round, none of
 * which touch step rows. A run that reviewed for 33 minutes therefore arrived at
 * its checks with a 33-minute-old clock, already past both idle thresholds, and
 * was reaped 4 seconds after dispatching its jobs — with the reviewer's approval
 * as the last thing in the session. Losing either term reintroduces that.
 */

/**
 * Build the progress-clock expression (ms since epoch) for a run.
 *
 * @param runRef How the `finalize_runs` row is referenced in the enclosing
 *   statement — an alias (`r`) in the candidate SELECT, or the bare table name
 *   (`finalize_runs`) in the UPDATE, where SQLite requires it for the
 *   correlated sub-selects.
 */
export function stuckRunProgressClockSql(runRef: string): string {
  return `MAX(
                COALESCE(${runRef}.started_at, 0),
                COALESCE(${runRef}.phase_changed_at, 0),
                COALESCE((SELECT MAX(s.started_at) FROM finalize_run_steps s WHERE s.run_id = ${runRef}.id), 0),
                COALESCE((SELECT MAX(s.ended_at)   FROM finalize_run_steps s WHERE s.run_id = ${runRef}.id), 0),
                COALESCE((SELECT MAX(j.started_at) FROM finalize_run_jobs  j WHERE j.run_id = ${runRef}.id), 0),
                COALESCE((SELECT MAX(j.ended_at)   FROM finalize_run_jobs  j WHERE j.run_id = ${runRef}.id), 0)
              )`;
}
