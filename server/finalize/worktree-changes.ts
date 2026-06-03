/**
 * Worktree change detection for Finalize / push affordances.
 */
import { checkWorktreeChanges, type WorktreeChanges } from '../auto-git.js';

export type CommittableChangesResult =
  | { ok: true; changes: WorktreeChanges }
  | { ok: false; error: 'no_worktree' | 'no_committable_changes'; message: string };

export function isCommittable(changes: WorktreeChanges): boolean {
  return changes.hasUncommitted || changes.hasUnpushed;
}

export async function getSessionCommittableChanges(
  worktreePath: string | null | undefined,
): Promise<CommittableChangesResult> {
  if (!worktreePath) {
    return {
      ok: false,
      error: 'no_worktree',
      message: 'Session has no worktree.',
    };
  }
  const changes = await checkWorktreeChanges(worktreePath);
  if (!isCommittable(changes)) {
    return {
      ok: false,
      error: 'no_committable_changes',
      message: 'No committable changes in the session worktree.',
    };
  }
  return { ok: true, changes };
}
