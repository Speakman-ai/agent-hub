/**
 * Whether a session has local work the operator can ship.
 *
 * Only commits count. Finalize reviews, tests, and pushes commits — it never
 * commits the working tree — so uncommitted edits are not shippable work no
 * matter how many files the Changes badge counts.
 */
export function hasCommittableChangesFromReady(changes: any) {
  if (!changes || typeof changes !== 'object') return false;
  return Boolean(changes.hasUnpushed);
}

/**
 * Tooltip when Finalize / Push are disabled for lack of committable work.
 *
 * The uncommitted case gets its own copy: an operator looking at a Changes
 * badge counting their edited files reads a bare "no changes here" as the app
 * losing their work, when the actual problem is that nothing was committed.
 */
export function noCommittableChangesTooltip(branchLabel: any = '', changes: any = null) {
  const branchPart = branchLabel ? ` (${branchLabel})` : '';
  if (changes && typeof changes === 'object' && changes.hasUncommitted) {
    return (
      `This session's worktree${branchPart} has uncommitted changes but no commits on the branch. ` +
      'Finalize reviews and pushes commits, not the working tree — commit the work to enable it.'
    );
  }
  return (
    `No commits to ship in this session's worktree${branchPart}. ` +
    'Commit here, not the project checkout, to enable the runner.'
  );
}
