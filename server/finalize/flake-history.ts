/**
 * flake-history.ts — per-instance flake history + flake-rate computation.
 *
 * The Finalize pipeline records pass/fail at job/matrix-instance granularity
 * (a `job_id` + `matrix_key`), not per individual test case, so the "test" we
 * track flakiness for is the job instance — the same unit the flake-recovery
 * gate already reasons about (`flake-recovery.ts`).
 *
 * Two halves, both pure so the math is unit-testable without a DB:
 *
 *   1. {@link deriveRunInstanceOutcomes} — collapse one run's per-round
 *      attempt history (the `finalize_run_job_attempts` rows) into one outcome
 *      per instance: its final state, and whether it *flaked within the run*
 *      (failed an earlier round then passed a later one — a fail→pass flip
 *      with no proven fixer is the in-run flake signal).
 *
 *   2. {@link computeFlakeRate} / {@link summarizeFlakeHistory} — aggregate
 *      the per-run outcomes recorded across many runs (the
 *      `finalize_test_history` rows) into a flake rate per instance.
 *
 * Persistence + git I/O live in the glue (`quarantine-gate.ts`) and DB layer;
 * this module owns only the arithmetic.
 */

import type { JobAttemptState, JobRoundAttempt } from './flake-recovery.js';

/** Terminal per-run state of a single job instance (passed/failed only). */
export type InstanceFinalState = 'passed' | 'failed';

/** One run's collapsed outcome for a single job/matrix instance. */
export interface InstanceOutcome {
  jobId: string;
  matrixKey: string;
  /** Latest terminal state observed across the run's rounds. */
  finalState: InstanceFinalState;
  /**
   * True when the instance failed an earlier round and then passed a later
   * round **on the same `headSha`** — a bare rerun-to-green with no commit
   * landed between, which is the unambiguous in-run flake signal. A pass after
   * the head CHANGED is treated as a (possible) real fix, not a flake (see
   * {@link deriveRunInstanceOutcomes}). A run that only ever passed, or only
   * ever failed, did not flake.
   */
  flaked: boolean;
}

/**
 * Collision-safe grouping/lookup key for a job instance. A plain
 * `${jobId} ${matrixKey}` join collides for valid string pairs (e.g.
 * `('a b','c')` vs `('a','b c')`), so we JSON-encode the tuple — an
 * unambiguous, human-readable separator. Exported so external callers (e.g.
 * the flake REST route's quarantine annotation) key against the SAME function
 * the summary uses, rather than re-deriving a colliding key of their own.
 */
export function instanceKey(jobId: string, matrixKey: string): string {
  return JSON.stringify([jobId, matrixKey ?? '']);
}

/**
 * Collapse a run's per-round attempts into one {@link InstanceOutcome} per
 * job/matrix instance. Non-terminal observations (`queued`/`running`/
 * `skipped`) are ignored; an instance with no terminal observation is dropped
 * (it never produced a real result to judge).
 *
 * `flaked` is true iff the instance failed an earlier round and then passed a
 * later round **on the same `headSha`** — a bare rerun-to-green with no commit
 * between rounds, which is the unambiguous in-run flake signal. When the head
 * CHANGED between the failing and the passing round a fixer commit landed, and
 * raw round order alone cannot distinguish a real fix from a laundered flake;
 * counting that as a flake would brand every normal `failed@oldSha ->
 * passed@newSha` fix as flaky and contaminate the flake stats, so we
 * conservatively do NOT count it. (The richer path-aware fix-vs-flake call,
 * which uses the git diff, lives in the gate — `flake-recovery.ts`; this
 * mirrors its `failHead === passHead -> flake_recovered` signal without
 * needing git.) The final state is the latest terminal round's state.
 */
export function deriveRunInstanceOutcomes(attempts: JobRoundAttempt[]): InstanceOutcome[] {
  const byInstance = new Map<string, JobRoundAttempt[]>();
  for (const a of attempts) {
    const key = instanceKey(a.jobId, a.matrixKey);
    const arr = byInstance.get(key);
    if (arr) arr.push(a);
    else byInstance.set(key, [a]);
  }

  const outcomes: InstanceOutcome[] = [];
  for (const group of byInstance.values()) {
    const terminal = group
      .filter((a) => a.state === 'passed' || a.state === 'failed')
      .sort((a, b) => a.round - b.round);
    if (terminal.length === 0) continue;
    const { jobId, matrixKey } = group[0];
    const last = terminal[terminal.length - 1];
    const finalState: InstanceFinalState = last.state === 'passed' ? 'passed' : 'failed';

    // flaked = passed on a head it had ALSO failed on in an earlier round
    // (same headSha, both non-null) — a rerun-to-green with no new commit. A
    // pass on a head that differs from every prior failing head means a commit
    // landed between, which we treat as a (possible) real fix, not a flake.
    let flaked = false;
    for (let j = 0; j < terminal.length && !flaked; j++) {
      const pass = terminal[j];
      if (pass.state !== 'passed' || pass.headSha == null) continue;
      for (let i = 0; i < j; i++) {
        const fail = terminal[i];
        if (fail.state === 'failed' && fail.headSha != null && fail.headSha === pass.headSha) {
          flaked = true;
          break;
        }
      }
    }

    outcomes.push({ jobId, matrixKey, finalState, flaked });
  }
  return outcomes;
}

// ─── Cross-run aggregation ──────────────────────────────────────────────────

/** One recorded per-run outcome for an instance (a `finalize_test_history` row). */
export interface FlakeHistoryRecord {
  jobId: string;
  matrixKey: string;
  finalState: InstanceFinalState;
  flaked: boolean;
  recordedAt: number;
}

/** Aggregate flake statistics for a single job/matrix instance. */
export interface FlakeRate {
  /** Total runs observed for the instance in the window. */
  runs: number;
  /** Runs whose final state was `failed`. */
  failedRuns: number;
  /** Runs where the instance flaked within the run (same-head rerun-to-green). */
  flakedRuns: number;
  /**
   * Flake rate ∈ [0, 1]: fraction of observed runs in which the instance
   * either flaked within the run OR ended failed. Both are unreliability
   * signals; a run that flipped fail→pass and a run that ended red are each
   * evidence the instance is not deterministically green.
   */
  flakeRate: number;
  /** Fraction of observed runs that ended failed ∈ [0, 1]. */
  failRate: number;
}

/** Compute the {@link FlakeRate} for one instance's recorded history. */
export function computeFlakeRate(records: FlakeHistoryRecord[]): FlakeRate {
  const runs = records.length;
  if (runs === 0) {
    return { runs: 0, failedRuns: 0, flakedRuns: 0, flakeRate: 0, failRate: 0 };
  }
  let failedRuns = 0;
  let flakedRuns = 0;
  let unreliableRuns = 0;
  for (const r of records) {
    const failed = r.finalState === 'failed';
    if (failed) failedRuns += 1;
    if (r.flaked) flakedRuns += 1;
    if (failed || r.flaked) unreliableRuns += 1;
  }
  return {
    runs,
    failedRuns,
    flakedRuns,
    flakeRate: unreliableRuns / runs,
    failRate: failedRuns / runs,
  };
}

/** Per-instance flake summary: identity + rate + when it was last observed. */
export interface FlakeInstanceStat extends FlakeRate {
  jobId: string;
  matrixKey: string;
  /** Most recent `recordedAt` across the instance's history. */
  lastSeen: number;
}

/**
 * Group recorded history by instance and compute a {@link FlakeInstanceStat}
 * for each, sorted by descending flake rate then descending run count (the
 * most flaky, best-evidenced instances first).
 */
export function summarizeFlakeHistory(
  records: Array<FlakeHistoryRecord & { jobId: string; matrixKey: string }>,
): FlakeInstanceStat[] {
  const groups = new Map<
    string,
    Array<FlakeHistoryRecord & { jobId: string; matrixKey: string }>
  >();
  for (const r of records) {
    const key = instanceKey(r.jobId, r.matrixKey);
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }
  const stats: FlakeInstanceStat[] = [];
  for (const group of groups.values()) {
    const { jobId, matrixKey } = group[0];
    const rate = computeFlakeRate(group);
    const lastSeen = group.reduce((acc, r) => Math.max(acc, r.recordedAt), 0);
    stats.push({ jobId, matrixKey, lastSeen, ...rate });
  }
  stats.sort((a, b) => b.flakeRate - a.flakeRate || b.runs - a.runs);
  return stats;
}

/** Default options for {@link isFlaky}. */
export interface FlakyThreshold {
  /** Minimum runs observed before a verdict is trustworthy (default 3). */
  minRuns?: number;
  /** Flake-rate threshold above which the instance counts as flaky (default 0.1). */
  minFlakeRate?: number;
}

/**
 * Is an instance flaky enough to warrant quarantine consideration? Requires a
 * minimum sample size so a single unlucky run does not brand a healthy test as
 * flaky. Pure — the gate/UI decides what to do with the verdict.
 */
export function isFlaky(stat: FlakeRate, opts: FlakyThreshold = {}): boolean {
  const minRuns = opts.minRuns ?? 3;
  const minFlakeRate = opts.minFlakeRate ?? 0.1;
  return stat.runs >= minRuns && stat.flakeRate > minFlakeRate;
}

/** Re-export for callers that map raw attempt states. */
export type { JobAttemptState };
