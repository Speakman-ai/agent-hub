/**
 * prerebase-backup.ts — Finalize rebase-phase commit-loss guard.
 *
 * The rebase phase rewrites the session's worktree branch onto `origin/<base>`.
 * If the rebase drops the session's commits — patch-equivalent to changes that
 * already landed on base (a competing implementation), or a conflict
 * resolution that took base's side — the branch tip can end up with ZERO net
 * changes vs base. Finalize would then push an empty diff and, under Merge
 * Automatically (the kanban/autonomous default), move the card to Done:
 * silently shipping nothing while orphaning the pre-rebase commits so they are
 * reachable from no ref and eventually GC'd.
 *
 * This is exactly how card AH-1219 ("SMTP email transport and settings UI")
 * lost a fully-reviewed 2406-line commit: it branched off a stale `main`, a
 * parallel feature added a competing `email-sender.ts`, and the rebase onto
 * the advanced `main` dropped the session's work. See the wiki page
 * `finalize-zero-diff-finalized-commits`.
 *
 * Two protections, both rooted here:
 *   1. Before the first rebase rewrites the branch, snapshot the branch tip to
 *      a durable backup ref (`refs/finalize/prerebase/<runId>`). The pre-rebase
 *      commits stay reachable and recoverable no matter what the rebase does —
 *      the literal "never lose commits" guarantee.
 *   2. After a clean rebase, if the branch HAD net changes vs base before and
 *      has NONE after, the rebase dropped the session's work — the phase fails
 *      (`rebase_dropped_commits`) instead of advancing to push, so the card is
 *      never marked Done on an empty integration.
 *
 * All git here goes through the rebase phase's injectable `runGit` seam, so the
 * unit tests drive it deterministically. Change-detection uses
 * `git diff --shortstat <base>...HEAD` (always exit 0; empty stdout means no
 * net change) rather than `--quiet`, because the shared `runGit` rejects on a
 * non-zero git exit.
 */

export type RunGitFn = (
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

/** Per-call timeout for the small ref/diff git invocations this guard makes. */
const GUARD_GIT_TIMEOUT_MS = 15_000;

/**
 * Durable backup ref for a run's pre-rebase branch tip. Named refs are GC
 * roots, so the snapshot survives even if the rebase rewrites the branch away
 * from those commits.
 */
export function backupRefName(runId: string): string {
  // Ref path components can't contain spaces, `~^:?*[`, `..`, etc. Run ids are
  // hex/uuid in practice; sanitize defensively so a malformed id can never
  // produce an invalid (and therefore silently un-written) ref.
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
  return `refs/finalize/prerebase/${safe}`;
}

export interface PreRebaseBaseline {
  /** Pre-rebase branch tip SHA, or null if it could not be resolved. */
  headSha: string | null;
  /** Did the branch have net changes vs `origin/<base>` before the rebase? */
  hadChangesVsBase: boolean;
  /** The backup ref the tip was (attempted to be) written to. */
  backupRef: string;
  /** True when the backup ref was written successfully. */
  backupWritten: boolean;
}

/** True when `git diff --shortstat origin/<base>...HEAD` reports any change. */
export async function worktreeHasChangesVsBase(
  runGit: RunGitFn,
  opts: { cwd: string; baseBranch: string; env?: NodeJS.ProcessEnv },
): Promise<boolean> {
  const { stdout } = await runGit(['diff', '--shortstat', `origin/${opts.baseBranch}...HEAD`], {
    cwd: opts.cwd,
    timeoutMs: GUARD_GIT_TIMEOUT_MS,
    env: opts.env,
  });
  return stdout.trim().length > 0;
}

/**
 * Snapshot the current branch tip to a backup ref and record whether it has
 * net changes vs base. Best-effort: any git failure degrades to a baseline
 * that DISABLES drop-detection (`headSha: null`) rather than throwing — the
 * rebase phase must still run even if the snapshot couldn't be taken. Failing
 * open on *detection* is safe because the snapshot is the recovery net and the
 * push-side empty-integration gate is the backstop; failing the whole phase
 * because we couldn't read git state would be worse than the status quo.
 */
export async function capturePreRebaseBaseline(
  runGit: RunGitFn,
  opts: { cwd: string; baseBranch: string; runId: string; env?: NodeJS.ProcessEnv },
): Promise<PreRebaseBaseline> {
  const backupRef = backupRefName(opts.runId);
  let headSha: string | null = null;
  let hadChangesVsBase = false;
  let backupWritten = false;

  try {
    const { stdout } = await runGit(['rev-parse', 'HEAD'], {
      cwd: opts.cwd,
      timeoutMs: GUARD_GIT_TIMEOUT_MS,
      env: opts.env,
    });
    headSha = stdout.trim() || null;
  } catch {
    headSha = null;
  }

  if (headSha) {
    try {
      await runGit(['update-ref', backupRef, headSha], {
        cwd: opts.cwd,
        timeoutMs: GUARD_GIT_TIMEOUT_MS,
        env: opts.env,
      });
      backupWritten = true;
    } catch {
      backupWritten = false;
    }
    try {
      hadChangesVsBase = await worktreeHasChangesVsBase(runGit, {
        cwd: opts.cwd,
        baseBranch: opts.baseBranch,
        env: opts.env,
      });
    } catch {
      hadChangesVsBase = false;
    }
  }

  return { headSha, hadChangesVsBase, backupRef, backupWritten };
}

/**
 * Pure decision: given the pre-rebase baseline and whether the post-rebase
 * branch still has changes vs base, did the rebase silently drop the session's
 * commits? Only fires when we captured a real baseline (a SHA we could read
 * that had net changes) and the post-rebase branch has none — so an
 * intentionally empty session, or a run where the baseline couldn't be read,
 * never trips it.
 */
export function rebaseDroppedAllChanges(
  baseline: Pick<PreRebaseBaseline, 'headSha' | 'hadChangesVsBase'>,
  postHasChangesVsBase: boolean,
): boolean {
  return Boolean(baseline.headSha) && baseline.hadChangesVsBase && !postHasChangesVsBase;
}
