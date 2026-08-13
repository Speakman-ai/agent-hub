import type { PullRequestRow, Stmts } from '../types.js';

/**
 * GitHub-GraphQL-style review decision for list rows: latest review per
 * reviewer wins (comments never supersede a verdict), changes-requested
 * beats approved, and a pending review-request flag reads as
 * REVIEW_REQUIRED.
 */
export function reviewDecisionFor(
  stmts: Stmts,
  projectId: string,
  row: Pick<PullRequestRow, 'number' | 'review_requested_at'>,
): string | null {
  const reviews = stmts.listPullRequestReviewsForPr.all(projectId, row.number) as Array<{
    reviewer: string;
    state: string;
    dismissed_at: number | null;
  }>;
  const latestByUser = new Map<string, string>();
  for (const r of reviews) {
    // Dismissed reviews keep their history row but no longer carry a verdict.
    if (r.dismissed_at) continue;
    const prev = latestByUser.get(r.reviewer);
    if (r.state === 'commented' && prev && prev !== 'commented') continue;
    latestByUser.set(r.reviewer, r.state);
  }
  const states = [...latestByUser.values()];
  if (states.includes('changes_requested')) return 'CHANGES_REQUESTED';
  if (states.includes('approved')) return 'APPROVED';
  if (row.review_requested_at) return 'REVIEW_REQUIRED';
  return null;
}
