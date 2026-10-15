/**
 * Infra-retry carry-over: which job instances of a parent run can be reused by
 * its infra retry instead of re-running.
 *
 * An infra retry (Spot reclaim, lost runner, Hub blip) opens a new run against
 * the same session. When the retry tests the exact commit the parent tested,
 * every instance that already passed in the parent has nothing new to prove, so
 * only the instances that did not pass run again. The job runner then confirms
 * each candidate's step layout still matches before copying its rows (see
 * `carryOver` in job-runner.ts), which catches a ci config that changed between
 * the two runs.
 */
import { jobInstanceKey } from './base-drift-policy.js';
import type { FinalizeRunJobAttemptRow, FinalizeRunJobRow, Stmts } from '../types.js';

export type RetryCarryOverStmts = Pick<
  Stmts,
  'listFinalizeRunJobsForRun' | 'listFinalizeRunJobAttemptsForRun'
>;

/**
 * Instances (keyed by `jobInstanceKey`) the retry may carry over from
 * `parentRunId`. An instance qualifies when the parent's final job row is
 * `passed` AND the parent's latest recorded round for it passed at `headSha`.
 * The head check is the "no code changes" guarantee: a rebase onto a moved
 * base or a fix commit changes the head, and then nothing carries over.
 *
 * Any read failure returns an empty set, which means a full re-run.
 */
export function collectRetryCarryOver(
  stmts: RetryCarryOverStmts,
  parentRunId: string,
  headSha: string,
): Set<string> {
  const keys = new Set<string>();
  if (!headSha) return keys;
  let jobs: FinalizeRunJobRow[];
  let attempts: FinalizeRunJobAttemptRow[];
  try {
    jobs = stmts.listFinalizeRunJobsForRun.all(parentRunId) as FinalizeRunJobRow[];
    attempts = stmts.listFinalizeRunJobAttemptsForRun.all(
      parentRunId,
    ) as FinalizeRunJobAttemptRow[];
  } catch {
    return keys;
  }
  const latest = new Map<string, FinalizeRunJobAttemptRow>();
  for (const row of attempts) {
    const key = jobInstanceKey(row.job_id, row.matrix_key);
    const prev = latest.get(key);
    if (!prev || row.round > prev.round) latest.set(key, row);
  }
  for (const job of jobs) {
    if (job.state !== 'passed') continue;
    const key = jobInstanceKey(job.job_id, job.matrix_key);
    const attempt = latest.get(key);
    if (attempt?.state === 'passed' && attempt.head_sha === headSha) keys.add(key);
  }
  return keys;
}
