/**
 * store.ts — DB layer for native pull requests.
 *
 * Number allocation runs inside a better-sqlite3 transaction together
 * with the insert; better-sqlite3 is synchronous, so MAX(number)+1 is
 * race-free in-process (the Hub is the only writer).
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.js';
import type { PullRequestRow, Stmts } from '../types.js';

export interface CreateOrGetOpenPrArgs {
  projectId: string;
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  /** Hub user id who opened the pull request. */
  author: string;
}

/**
 * Idempotent create: an open PR for the same head branch is reused (its
 * head_sha/title/body refreshed), mirroring the GitHub path's
 * `gh pr list --head` check before `gh pr create`.
 */
export function createOrGetOpenPullRequest(
  stmts: Stmts,
  args: CreateOrGetOpenPrArgs,
): { row: PullRequestRow; created: boolean } {
  const run = getDb().transaction((): { row: PullRequestRow; created: boolean } => {
    const now = Date.now();
    const existing = stmts.getOpenPullRequestByHeadBranch.get(args.projectId, args.headBranch) as
      | PullRequestRow
      | undefined;
    if (existing) {
      stmts.updatePullRequestHead.run(args.headSha, args.title, args.body, now, existing.id);
      const refreshed = stmts.getPullRequestByNumber.get(
        args.projectId,
        existing.number,
      ) as PullRequestRow;
      return { row: refreshed, created: false };
    }
    const maxRow = stmts.maxPullRequestNumberForProject.get(args.projectId) as {
      max_number: number;
    };
    const number = maxRow.max_number + 1;
    const id = uuidv4();
    stmts.insertPullRequest.run(
      id,
      args.projectId,
      number,
      args.title,
      args.body,
      args.headBranch,
      args.baseBranch,
      args.headSha,
      args.author,
      now,
      now,
    );
    const row = stmts.getPullRequestByNumber.get(args.projectId, number) as PullRequestRow;
    return { row, created: true };
  });
  return run();
}

export function getPullRequest(
  stmts: Stmts,
  projectId: string,
  number: number,
): PullRequestRow | null {
  return (
    (stmts.getPullRequestByNumber.get(projectId, number) as PullRequestRow | undefined) ?? null
  );
}

export type PrListState = 'open' | 'closed' | 'all';

export function listPullRequests(
  stmts: Stmts,
  projectId: string,
  state: PrListState,
  limit: number,
): PullRequestRow[] {
  return stmts.listPullRequestsForProject.all(
    projectId,
    state,
    state,
    state,
    limit,
  ) as PullRequestRow[];
}

/**
 * Every PR (any state) whose base or head branch is `branch`. Unbounded — the
 * set is naturally scoped to a single branch, so nothing gets paged out.
 *
 * The branch is trimmed before matching so it agrees with the in-memory
 * matchers (`matchEpicForPrBranches` / `prsForEpicFeatureBranch`), which treat
 * blank-after-trim as "no branch". A blank branch returns `[]` rather than
 * running a predicate that could never match a stored (trimmed) branch.
 */
export function listPullRequestsForBranch(
  stmts: Stmts,
  projectId: string,
  branch: string,
): PullRequestRow[] {
  const normalized = branch.trim();
  if (!normalized) return [];
  return stmts.listPullRequestsForBranch.all(projectId, normalized, normalized) as PullRequestRow[];
}

/**
 * Guarded open → merged transition. Returns the updated row, or null when
 * the row wasn't open anymore (someone else merged/closed it first).
 */
export function markMerged(
  stmts: Stmts,
  row: PullRequestRow,
  args: { mergedSha: string; mergedBy: string; mergeMethod: 'squash' | 'merge' },
): PullRequestRow | null {
  const now = Date.now();
  const result = stmts.markPullRequestMerged.run(
    args.mergedSha,
    args.mergedBy,
    args.mergeMethod,
    now,
    now,
    row.id,
  );
  if (result.changes === 0) return null;
  return getPullRequest(stmts, row.project_id, row.number);
}

/** Guarded open → closed transition; null when the row wasn't open. */
export function markClosed(stmts: Stmts, row: PullRequestRow): PullRequestRow | null {
  const now = Date.now();
  const result = stmts.markPullRequestClosed.run(now, now, row.id);
  if (result.changes === 0) return null;
  return getPullRequest(stmts, row.project_id, row.number);
}
