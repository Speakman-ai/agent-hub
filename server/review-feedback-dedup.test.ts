import { describe, it, expect, beforeEach } from 'vitest';
import {
  lastDispatchedReviewId,
  recordDispatchedChangesRequestedReview,
} from './review-feedback-dedup.js';

describe('review-feedback-dedup', () => {
  beforeEach(() => {
    lastDispatchedReviewId.clear();
  });

  it('records monotonic max review id per card', () => {
    recordDispatchedChangesRequestedReview('c1', 100);
    expect(lastDispatchedReviewId.get('c1')).toBe(100);
    recordDispatchedChangesRequestedReview('c1', 80);
    expect(lastDispatchedReviewId.get('c1')).toBe(100);
    recordDispatchedChangesRequestedReview('c1', 120);
    expect(lastDispatchedReviewId.get('c1')).toBe(120);
  });

  it('ignores non-finite review ids', () => {
    recordDispatchedChangesRequestedReview('c1', Number.NaN);
    recordDispatchedChangesRequestedReview('c1', 0);
    recordDispatchedChangesRequestedReview('c1', -1);
    expect(lastDispatchedReviewId.get('c1')).toBeUndefined();
  });
});
