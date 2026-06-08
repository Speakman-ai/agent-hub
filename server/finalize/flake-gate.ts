/**
 * flake-gate.ts — orchestrator-side glue for flake-recovery detection.
 *
 * Two responsibilities, both kept out of orchestrator.ts so the heavy git
 * I/O and DB fan-out don't clutter the state machine:
 *
 *   1. {@link recordJobAttemptsForRound} — snapshot the current per-job state
 *      into `finalize_run_job_attempts` once per loop_round, tagged with the
 *      post-rebase HEAD the round validated against. `finalize_run_jobs` only
 *      keeps the LATEST state per instance (it upserts in place), so without
 *      this snapshot the "failed round N, passed round M" history is lost.
 *
 *   2. {@link classifyRunFlakeRecovery} — at the push gate, load the recorded
 *      history, resolve the change-set between each recovered instance's
 *      failing and passing heads, and run the pure classifier
 *      (`flake-recovery.ts`) to decide which jobs laundered a flake into green.
 *
 * The pure decision lives in flake-recovery.ts; this module only feeds it real
 * data. The git diff is injectable so orchestrator tests never shell out.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AnyCiConfig } from './ci-config.js';
import type { FinalizeRunJobAttemptRow, FinalizeRunJobRow, Stmts } from '../types.js';
import {
  blockedGateResult,
  classifyJobRetryHistory,
  gateResultFromVerdicts,
  type FlakeGateResult,
  type JobRoundAttempt,
} from './flake-recovery.js';

const execFileAsync = promisify(execFile);

export type GitChangedFilesFn = (
  worktreePath: string,
  fromHead: string,
  toHead: string,
  env?: NodeJS.ProcessEnv,
) => Promise<string[] | null>;

/**
 * `git diff --name-only <from>..<to>` in the worktree. Returns `null` (not
 * `[]`) on any failure so the classifier can tell "no files changed" from
 * "couldn't resolve the range". The latter fails the gate closed: an
 * unresolved range for a recovered job is classified `unresolved` → `blocked`
 * (we can't prove a fixer commit existed), NOT treated as a real fix.
 */
export const defaultGitChangedFiles: GitChangedFilesFn = async (
  worktreePath,
  fromHead,
  toHead,
  env,
) => {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--name-only', `${fromHead}..${toHead}`],
      { cwd: worktreePath, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return null;
  }
};

/**
 * Append/refresh this round's per-job state into the retry-history table.
 *
 * Returns `true` only when the listing AND every per-job upsert succeeded — i.e.
 * the round's failed/passed evidence is durably recorded. Returns `false` on any
 * failure. The caller MUST treat a `false` as a reason to fail the flake gate
 * closed: without durable per-round history, a later round can't tell a real
 * fix from a laundered flake, and the run must not be auto-pushed. The function
 * never throws (so it can't crash the loop), but it no longer hides failures.
 */
export function recordJobAttemptsForRound(
  deps: {
    stmts: Pick<Stmts, 'listFinalizeRunJobsForRun' | 'upsertFinalizeRunJobAttempt'>;
    now?: () => number;
    log?: (msg: string) => void;
  },
  args: { runId: string; round: number; headSha: string | null },
): boolean {
  const now = deps.now ?? Date.now;
  let jobs: FinalizeRunJobRow[];
  try {
    jobs = deps.stmts.listFinalizeRunJobsForRun.all(args.runId) as FinalizeRunJobRow[];
  } catch (err) {
    deps.log?.(
      `[finalize-flake-gate] listFinalizeRunJobsForRun failed run=${args.runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
  let allPersisted = true;
  for (const job of jobs) {
    try {
      deps.stmts.upsertFinalizeRunJobAttempt.run(
        args.runId,
        job.job_id,
        job.matrix_key,
        args.round,
        job.state,
        job.exit_code,
        args.headSha,
        now(),
      );
    } catch (err) {
      allPersisted = false;
      deps.log?.(
        `[finalize-flake-gate] upsertFinalizeRunJobAttempt failed run=${args.runId} ` +
          `job=${job.job_id} round=${args.round}: ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
    }
  }
  return allPersisted;
}

/** Per-instance grouping helper mirroring the classifier's instance key. */
function groupByInstance(attempts: JobRoundAttempt[]): Map<string, JobRoundAttempt[]> {
  const byInstance = new Map<string, JobRoundAttempt[]>();
  for (const a of attempts) {
    const key = `${a.jobId} ${a.matrixKey}`;
    const arr = byInstance.get(key);
    if (arr) arr.push(a);
    else byInstance.set(key, [a]);
  }
  return byInstance;
}

/**
 * Load the run's recorded retry history, resolve the change-sets the
 * classifier needs, and classify every job/matrix instance into a
 * {@link FlakeGateResult}.
 *
 * Fail-closed contract (the whole point of this gate):
 *
 *   - history query throws            → `blocked` (can't read evidence).
 *   - `attemptsPersisted === false`   → `blocked` (evidence wasn't durably
 *                                       written this run; passed in by the
 *                                       orchestrator from recordJobAttempts...).
 *   - `expectAttempts && rows empty`  → `blocked` (a v2 run reached the gate but
 *                                       no job history exists — recording must
 *                                       have silently produced nothing).
 *   - `!expectAttempts && rows empty` → `clean` (v1 step run; no jobs to judge).
 *   - otherwise                       → classify; `flake_recovered` or `clean`.
 */
export async function classifyRunFlakeRecovery(
  deps: {
    stmts: Pick<Stmts, 'listFinalizeRunJobAttemptsForRun'>;
    gitChangedFiles?: GitChangedFilesFn;
    log?: (msg: string) => void;
  },
  args: {
    runId: string;
    worktreePath: string;
    env?: NodeJS.ProcessEnv;
    config: AnyCiConfig | null;
    /** True when the tasks phase ran jobs we expect history for (v2). */
    expectAttempts?: boolean;
    /** False when any round's per-round history failed to persist. */
    attemptsPersisted?: boolean;
  },
): Promise<FlakeGateResult> {
  // Evidence was not durably recorded — cannot verify the run is clean.
  if (args.attemptsPersisted === false) {
    return blockedGateResult(
      'per-round job attempt history failed to persist; cannot verify flake recovery',
    );
  }

  let rows: FinalizeRunJobAttemptRow[];
  try {
    rows = deps.stmts.listFinalizeRunJobAttemptsForRun.all(
      args.runId,
    ) as FinalizeRunJobAttemptRow[];
  } catch (err) {
    deps.log?.(
      `[finalize-flake-gate] listFinalizeRunJobAttemptsForRun failed run=${args.runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return blockedGateResult(
      `job attempt history query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (rows.length === 0) {
    // A v2 run that reached the gate should have recorded attempts; their
    // absence means recording silently produced nothing — fail closed. A v1
    // run has no jobs at all and is genuinely clean.
    return args.expectAttempts
      ? blockedGateResult('expected per-round job history is missing; cannot verify flake recovery')
      : { status: 'clean', jobs: [] };
  }

  const attempts: JobRoundAttempt[] = rows.map((r) => ({
    jobId: r.job_id,
    matrixKey: r.matrix_key,
    round: r.round,
    state: r.state,
    headSha: r.head_sha,
  }));

  // Per-job declared code-path globs (v2 only).
  const jobPaths = new Map<string, string[]>();
  if (args.config && args.config.version === 2) {
    for (const [jobId, job] of Object.entries(args.config.jobs)) {
      if (job.paths && job.paths.length > 0) jobPaths.set(jobId, job.paths);
    }
  }

  // Pre-resolve the (failHead, passHead) change-sets the classifier will ask
  // for. We mirror its selection — for each instance that failed then passed
  // on a different head, the last failing round's head → the passing head.
  const git = deps.gitChangedFiles ?? defaultGitChangedFiles;
  const rangeCache = new Map<string, string[] | null>();
  for (const group of groupByInstance(attempts).values()) {
    const terminal = group
      .filter((a) => a.state === 'passed' || a.state === 'failed')
      .sort((a, b) => a.round - b.round);
    const last = terminal[terminal.length - 1];
    if (!last || last.state !== 'passed') continue;
    const priorFailures = terminal.filter((a) => a.state === 'failed' && a.round < last.round);
    if (priorFailures.length === 0) continue;
    const failHead = priorFailures[priorFailures.length - 1].headSha;
    const passHead = last.headSha;
    if (!failHead || !passHead || failHead === passHead) continue;
    const key = `${failHead}..${passHead}`;
    if (rangeCache.has(key)) continue;
    rangeCache.set(key, await git(args.worktreePath, failHead, passHead, args.env));
  }

  const changedFilesBetween = (from: string, to: string): string[] | null => {
    const key = `${from}..${to}`;
    return rangeCache.has(key) ? rangeCache.get(key)! : null;
  };

  const verdicts = classifyJobRetryHistory(attempts, { changedFilesBetween, jobPaths });
  return gateResultFromVerdicts(verdicts);
}
