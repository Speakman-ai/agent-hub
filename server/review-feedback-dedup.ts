/**
 * Tracks the highest PR review id we've already dispatched author feedback for,
 * keyed by kanban card id, to avoid re-sending feedback for a review id already
 * handled. Cleared per-card by the board route when a card leaves review.
 * In-memory only — survives within a process run, reset on restart.
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
