/**
 * Merge-time base-drift gate for native PRs.
 *
 * Finalize's base-drift gate (finalize/base-drift.ts) runs when a branch is
 * pushed. A PR can then sit open for hours while the base keeps moving, and
 * the merge button trusted the push-time validation no matter what landed in
 * between. Two PRs that each add `training/migrations/0029_*.py` off the same
 * parent are both green on their own, merge cleanly in git, and leave the
 * migration graph with two leaves.
 *
 * So the merge re-asks the same question against the live repo: did commits
 * added to the base since this PR's merge-base touch ground the PR touches?
 * If the project's `baseDrift` policy would re-validate that push, the merge
 * needs fresh evidence first. Either the project's merge-check jobs pass on
 * the exact commit the merge would create, or the PR is updated and its checks
 * run on the new head.
 *
 * The validated base is the merge-base of the head and the current base tip.
 * Checks ran on the head commit, and the base only moves forward, so that
 * merge-base is exactly the base the checks saw. No recorded sha is needed,
 * which also covers PRs whose checks came from PR CI rather than Finalize.
 *
 * Fails open like the push-time gate: a repo the gate cannot read must not
 * wedge every merge.
 */

import { createHash } from 'crypto';
import { evaluateBaseDrift } from '../finalize/base-drift.js';
import {
  decideBaseDriftAction,
  resolveBaseDriftPolicy,
  type BaseDriftPolicy,
  type BaseDriftSettings,
} from '../finalize/base-drift-policy.js';
import { git as bareGit } from './git-read.js';

export type BareGitRunner = (args: string[]) => Promise<string>;

export type MergeDriftOutcome =
  | { kind: 'clear' }
  | {
      kind: 'stale';
      /** Live tip of the base branch. */
      baseTip: string;
      /** Directories (trailing slash) or files both sides changed. */
      overlap: string[];
      policy: BaseDriftPolicy;
    };

function splitPaths(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function summarizeOverlap(paths: string[]): string {
  const shown = paths.slice(0, 3).join(', ');
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
}

/** Did `baseBranch` move onto this PR's ground since `headSha` was built? */
export async function inspectMergeBaseDrift(args: {
  repoPath: string;
  baseBranch: string;
  headSha: string;
  baseDrift: BaseDriftSettings | null | undefined;
  git?: BareGitRunner;
  onWarn?: (message: string) => void;
}): Promise<MergeDriftOutcome> {
  const policy = resolveBaseDriftPolicy(args.baseDrift);
  if (policy.mode === 'off') return { kind: 'clear' };
  const run: BareGitRunner = args.git ?? ((gitArgs) => bareGit(args.repoPath, gitArgs));

  let baseTip: string;
  let mergeBase: string;
  let basePaths: string[];
  let branchPaths: string[];
  try {
    baseTip = (
      await run(['rev-parse', '--verify', `refs/heads/${args.baseBranch}^{commit}`])
    ).trim();
    mergeBase = (await run(['merge-base', args.headSha, baseTip])).trim();
    if (!baseTip || !mergeBase || mergeBase === baseTip) return { kind: 'clear' };
    basePaths = splitPaths(await run(['diff', '--name-only', mergeBase, baseTip]));
    branchPaths = splitPaths(await run(['diff', '--name-only', mergeBase, args.headSha]));
  } catch (err) {
    args.onWarn?.(
      `merge-time base drift not evaluated for ${args.headSha} against ${args.baseBranch}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { kind: 'clear' };
  }

  const outcome = evaluateBaseDrift({
    validatedBaseSha: mergeBase,
    currentBaseSha: baseTip,
    basePaths,
    branchPaths,
  });
  if (outcome.kind !== 'stale') return { kind: 'clear' };
  if (decideBaseDriftAction(outcome, policy).kind === 'proceed') return { kind: 'clear' };
  return { kind: 'stale', baseTip, overlap: outcome.overlap, policy };
}

/** Block reason for a stale PR with no merge-check jobs configured. */
export function updateBranchBlockReason(baseBranch: string, overlap: string[]): string {
  return (
    `Branch protection: since this PR's checks ran, ${baseBranch} changed ` +
    `${summarizeOverlap(overlap)}, which this PR also changes. Update the branch so ` +
    `checks run against the current ${baseBranch} before merging.`
  );
}

/** Idempotency-key prefix for merge-check runs: one per (PR head, base tip, job set). */
export function mergeCheckRunKey(
  projectId: string,
  headSha: string,
  baseTip: string,
  jobs: readonly string[],
): string {
  return `merge-check|${projectId}|${headSha}|${baseTip}|${mergeCheckJobsFingerprint(jobs)}`;
}

/**
 * Order-insensitive id of the configured merge-check job set. Part of the run
 * key, so a run that passed under an older or smaller job list never clears a
 * merge that now requires more.
 */
export function mergeCheckJobsFingerprint(jobs: readonly string[]): string {
  const normalized = [...new Set(jobs.map((j) => j.trim()).filter(Boolean))].sort();
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
}

/** Marker in the block reason while merge checks run; `merge()` arms auto-merge on it. */
export const MERGE_CHECKS_RUNNING = 'Merge checks are running';

/** What the latest merge-check run for a (head, base tip) pair says. */
export type MergeCheckState = 'none' | 'running' | 'passed' | 'failed';

export function mergeCheckStateFromRun(
  run: { status: string; failure_reason: string | null } | null | undefined,
): MergeCheckState {
  if (!run) return 'none';
  if (run.status === 'succeeded') return 'passed';
  if (run.status === 'queued' || run.status === 'running') return 'running';
  // A cancelled or infra-failed run proves nothing about the code; the next
  // merge attempt starts a fresh one.
  if (run.status === 'cancelled' || run.failure_reason === 'infra_error') return 'none';
  return 'failed';
}

/**
 * Block reason for a stale PR whose project runs merge checks. Wording keeps
 * the `checks are still running` / `checks have not run` substrings for the
 * pending states so auto-merge treats them as retryable (merge-block.ts).
 */
export function mergeCheckBlockReason(
  state: Exclude<MergeCheckState, 'passed'>,
  baseBranch: string,
  overlap: string[],
  failureReason?: string | null,
): string {
  const what = `${baseBranch} changed ${summarizeOverlap(overlap)} since this PR's checks ran`;
  if (state === 'running') {
    return (
      `Branch protection: ${what}. ${MERGE_CHECKS_RUNNING} on this PR combined with the ` +
      `current ${baseBranch} (checks are still running); it merges when they pass.`
    );
  }
  if (state === 'none') {
    return (
      `Branch protection: ${what}. Merge checks against the current ${baseBranch} ` +
      `(checks have not run yet) start when you merge.`
    );
  }
  return (
    `Branch protection: ${what}, and merge checks failed on this PR combined with the current ` +
    `${baseBranch}${failureReason ? ` (${failureReason})` : ''}. Update the branch and fix ` +
    `the failure before merging.`
  );
}
