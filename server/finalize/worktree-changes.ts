/**
 * Worktree change detection for Finalize / push affordances.
 */
import { checkWorktreeChanges, type WorktreeChanges } from '../auto-git.js';
import { hasPublishableChanges, type NetDiffProbe } from './net-diff.js';

export type CommittableChangesResult =
  | { ok: true; changes: WorktreeChanges }
  | { ok: false; error: 'no_worktree' | 'no_committable_changes'; message: string };

export function isCommittable(changes: WorktreeChanges): boolean {
  return changes.hasUncommitted || changes.hasUnpushed;
}

export async function getSessionCommittableChanges(
  worktreePath: string | null | undefined,
  probe?: NetDiffProbe,
): Promise<CommittableChangesResult> {
  if (!worktreePath) {
    return {
      ok: false,
      error: 'no_worktree',
      message: 'Session has no worktree.',
    };
  }
  const changes = await checkWorktreeChanges(worktreePath);
  // Unpushed commits alone are not enough: a branch whose commits net to zero
  // vs the base (already integrated / commit+revert) has nothing to ship, so
  // Finalize must not treat it as committable ("empty diff" report).
  if (!(await hasPublishableChanges(worktreePath, changes, probe))) {
    return {
      ok: false,
      error: 'no_committable_changes',
      message: 'No committable changes in the session worktree.',
    };
  }
  return { ok: true, changes };
}
