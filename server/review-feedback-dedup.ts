/**
 * Tracks the highest GitHub PR review id we've already dispatched author feedback
 * for, keyed by kanban card id. Shared by `pollForMissedReviews` and the
 * `pull_request_review.submitted` webhook so poll doesn't re-send after a successful
 * webhook (and both paths agree after restart only as far as in-memory state lasts).
 */
const lastDispatchedReviewId = new Map<string, number>();

/**
 * Record a successfully wired `changes_requested` (or equivalent) review event.
 * Only increases the stored id — never regresses, so a lower id is ignored.
 */
export function recordDispatchedChangesRequestedReview(cardId: string, reviewId: number): void {
  if (!Number.isFinite(reviewId) || reviewId <= 0) return;
  const prev = lastDispatchedReviewId.get(cardId);
  if (prev === undefined || reviewId > prev) {
    lastDispatchedReviewId.set(cardId, reviewId);
  }
}

export { lastDispatchedReviewId };
