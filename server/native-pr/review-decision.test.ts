import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReviews = vi.fn();

vi.mock('../db.js', () => ({
  getDb: () => ({}),
}));

vi.mock('../types.js', () => ({}));

describe('reviewDecisionFor', () => {
  beforeEach(() => {
    mockReviews.mockReset();
  });

  it('returns CHANGES_REQUESTED when any reviewer requested changes', async () => {
    const { reviewDecisionFor } = await import('./review-decision.js');
    mockReviews.mockReturnValue([
      { reviewer: 'alice', state: 'approved' },
      { reviewer: 'bob', state: 'changes_requested' },
    ]);
    const stmts = {
      listPullRequestReviewsForPr: { all: mockReviews },
    };
    expect(
      reviewDecisionFor(stmts as never, 'proj-1', {
        number: 7,
        review_requested_at: null,
      }),
    ).toBe('CHANGES_REQUESTED');
  });

  it('returns APPROVED when all latest reviews approve', async () => {
    const { reviewDecisionFor } = await import('./review-decision.js');
    mockReviews.mockReturnValue([{ reviewer: 'alice', state: 'approved' }]);
    const stmts = {
      listPullRequestReviewsForPr: { all: mockReviews },
    };
    expect(
      reviewDecisionFor(stmts as never, 'proj-1', {
        number: 7,
        review_requested_at: null,
      }),
    ).toBe('APPROVED');
  });

  it('returns REVIEW_REQUIRED when a review was requested and no verdict exists', async () => {
    const { reviewDecisionFor } = await import('./review-decision.js');
    mockReviews.mockReturnValue([]);
    const stmts = {
      listPullRequestReviewsForPr: { all: mockReviews },
    };
    expect(
      reviewDecisionFor(stmts as never, 'proj-1', {
        number: 7,
        review_requested_at: Date.now(),
      }),
    ).toBe('REVIEW_REQUIRED');
  });
});
