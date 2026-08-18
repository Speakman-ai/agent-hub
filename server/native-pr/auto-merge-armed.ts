/**
 * auto-merge-armed.ts — complete a native PR whose `auto_merge` flag is armed.
 *
 * Two callers share this one gate:
 *   1. the arm route / push-option, for an immediate attempt when the PR is
 *      already green, and
 *   2. the checks-passed hook (push/pr CI went green), to finish a PR that was
 *      armed while its checks were still in flight.
 *
 * Merging goes through {@link NativePrService.merge}, which enforces the same
 * branch-protection / mergeability gate the Merge button hits: a not-yet-ready
 * PR comes back as a 409 and stays armed for the next attempt, so this never
 * force-merges an unready PR. Idempotent — a merged/closed PR (or one whose
 * flag was cleared) is a no-op.
 */

import type { Project, PullRequestRow, Stmts } from '../types.js';
import type { NativePrService } from './service.js';
import type { MergeMethod } from './merge.js';

/** Sentinel actor recorded as the merger for an unattended auto-merge. */
export const NATIVE_AUTO_MERGE_ACTOR = 'auto-merge';

export interface TryAutoMergeDeps {
  stmts: Stmts;
  nativePr: NativePrService;
}

/**
 * Attempt to merge PR `number` iff it is open and auto-merge armed. Returns
 * `{ merged: true }` on a completed merge, `{ merged: false, reason }` when the
 * PR is not yet mergeable (checks pending / review required / conflict) so the
 * caller can leave it armed, and `{ merged: false }` when there is nothing to
 * do (not armed / not open / gone).
 */
export async function tryAutoMergeArmedNativePr(
  deps: TryAutoMergeDeps,
  args: { project: Project; number: number; mergeMethod?: MergeMethod },
): Promise<{ merged: boolean; reason?: string }> {
  const row = deps.stmts.getPullRequestByNumber.get(args.project.id, args.number) as
    | PullRequestRow
    | undefined;
  if (!row || row.status !== 'open' || row.auto_merge !== 1) return { merged: false };

  const result = await deps.nativePr.merge({
    project: args.project,
    number: args.number,
    mergeMethod: args.mergeMethod ?? 'squash',
    actor: NATIVE_AUTO_MERGE_ACTOR,
  });
  if (result.ok) return { merged: true };
  return { merged: false, reason: result.error };
}
