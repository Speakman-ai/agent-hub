/**
 * Whether a session has local work the operator can ship (uncommitted or unpushed).
 */
export function hasCommittableChangesFromReady(changes: any) {
  if (!changes || typeof changes !== 'object') return false;
  return Boolean(changes.hasUncommitted || changes.hasUnpushed);
}

/** Tooltip when Finalize / Push are disabled for lack of committable work. */
export function noCommittableChangesTooltip(branchLabel: any = '') {
  const branchPart = branchLabel ? ` (${branchLabel})` : '';
  return (
    `No uncommitted or unpushed commits in this session's worktree${branchPart}. ` +
    'Commit here, not the project checkout, to enable the runner.'
  );
}
