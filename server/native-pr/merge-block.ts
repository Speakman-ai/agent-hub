/**
 * merge-block.ts — classify native-PR merge block reasons.
 *
 * `mergeBlockedReason` (service.ts) returns human-readable strings. Some are
 * **transient**: a required check that is still running (or hasn't started)
 * will clear on its own once the run completes. The native Auto-Merge path
 * uses this to decide whether a refused merge should be re-attempted when the
 * checks finish (retryable) versus abandoned (terminal: changes requested,
 * checks failed, conflict).
 *
 * Matching is by stable substring so it survives the `autoMergeReadyPr`
 * wrapping (`native merge failed for <url> (status 409): <reason>`).
 */

/** Substrings of the branch-protection block reasons that clear on their own. */
const RETRYABLE_BLOCK_SUBSTRINGS = [
  'checks are still running', // checks queued/running for the head commit
  'checks have not run', // checks not started for the head commit yet
] as const;

/**
 * True when a merge block will resolve once in-flight required checks
 * complete — i.e. the merge should be retried on checks-passed, not dropped.
 */
export function isRetryableMergeBlock(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return RETRYABLE_BLOCK_SUBSTRINGS.some((s) => reason.includes(s));
}
