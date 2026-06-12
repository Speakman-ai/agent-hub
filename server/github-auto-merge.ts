/**
 * github-auto-merge.ts — make the "Auto Merge" automation level actually
 * merge the PR, the way a human clicking GitHub's merge button would.
 *
 * The old behavior ran only `gh pr merge --auto --squash`. GitHub's native
 * auto-merge only ever fires when the PR has a *pending* required check or
 * review to wait on. On a repo with no branch protection the PR is
 * immediately mergeable, so `--auto` silently no-ops (returns success but
 * never merges) — and on newer GitHub it 422s ("Auto merge is not allowed").
 * Either way the PR sits open forever, which is the "Auto Merge didn't merge"
 * complaint.
 *
 * So we try the immediate merge first. If branch protection blocks it
 * (required checks still pending, required review missing, repo prohibits a
 * direct merge), we fall back to enabling native auto-merge so GitHub
 * completes the merge once those requirements pass. Net effect: with
 * protection we wait like GitHub's UI would; without it we merge now.
 */

/** Runs `gh <args>`; resolves on exit 0, rejects (throws) on non-zero. */
export type GhRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

export type MergeMethodFlag = '--squash' | '--merge' | '--rebase';

export interface AutoMergeOutcome {
  /** PR was merged immediately. */
  merged: boolean;
  /** GitHub native auto-merge was enabled (GitHub merges when requirements pass). */
  autoEnabled: boolean;
  /** Human-readable note for logs. */
  note: string;
}

/**
 * Merge a GitHub PR, or enable native auto-merge if it can't be merged yet.
 *
 * @param prUrl  PR URL or number understood by `gh pr merge`.
 * @param runGh  Injected `gh` runner (rejects on non-zero exit).
 * @param method Merge strategy flag (default `--squash`).
 * @throws when neither an immediate merge nor enabling auto-merge succeeds.
 */
export async function mergeOrEnableGithubAutoMerge(
  prUrl: string,
  runGh: GhRunner,
  method: MergeMethodFlag = '--squash',
): Promise<AutoMergeOutcome> {
  // 1. Try to merge right now. Succeeds when the PR is already mergeable
  //    (no pending required checks/reviews) — the no-branch-protection case
  //    where native auto-merge would have silently no-op'd.
  try {
    await runGh(['pr', 'merge', method, prUrl]);
    return { merged: true, autoEnabled: false, note: `merged ${prUrl} (${method})` };
  } catch (immediateErr) {
    const immediateMsg =
      immediateErr instanceof Error ? immediateErr.message : String(immediateErr);
    // 2. Not mergeable yet (branch protection: pending checks / required
    //    review). Let GitHub finish the merge once requirements pass.
    try {
      await runGh(['pr', 'merge', '--auto', method, prUrl]);
      return {
        merged: false,
        autoEnabled: true,
        note: `enabled GitHub native auto-merge for ${prUrl} (immediate merge unavailable: ${immediateMsg})`,
      };
    } catch (autoErr) {
      const autoMsg = autoErr instanceof Error ? autoErr.message : String(autoErr);
      throw new Error(
        `could not merge or enable auto-merge for ${prUrl}: immediate=[${immediateMsg}]; auto=[${autoMsg}]`,
      );
    }
  }
}
