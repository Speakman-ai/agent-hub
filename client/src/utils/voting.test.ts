import { describe, it, expect, beforeEach } from 'vitest';
import { getVoterKey, computeOptimisticVote } from './voting';

describe('getVoterKey', () => {
  beforeEach(() => localStorage.clear());

  it('mints and persists a stable per-browser token', () => {
    const first = getVoterKey();
    expect(first).toBeTruthy();
    expect(localStorage.getItem('agent-hub-voter-key')).toBe(first);
    // Second call returns the same persisted token.
    expect(getVoterKey()).toBe(first);
  });

  it('reuses an existing stored token', () => {
    localStorage.setItem('agent-hub-voter-key', 'existing-token');
    expect(getVoterKey()).toBe('existing-token');
  });
});

describe('computeOptimisticVote', () => {
  it('upvotes from no vote: value=1, score +1, myVote=1', () => {
    const { value, tally } = computeOptimisticVote(
      { score: 3, upvotes: 3, downvotes: 0, myVote: null },
      'up',
    );
    expect(value).toBe(1);
    expect(tally).toEqual({ score: 4, upvotes: 4, downvotes: 0, myVote: 1 });
  });

  it('clicking up again retracts: value=null, score back down, myVote=null', () => {
    const { value, tally } = computeOptimisticVote(
      { score: 4, upvotes: 4, downvotes: 0, myVote: 1 },
      'up',
    );
    expect(value).toBeNull();
    expect(tally).toEqual({ score: 3, upvotes: 3, downvotes: 0, myVote: null });
  });

  it('flips a downvote to an upvote: score +2, up+1 down-1', () => {
    const { value, tally } = computeOptimisticVote(
      { score: 0, upvotes: 1, downvotes: 1, myVote: -1 },
      'up',
    );
    expect(value).toBe(1);
    expect(tally).toEqual({ score: 2, upvotes: 2, downvotes: 0, myVote: 1 });
  });

  it('downvotes from no vote: value=-1, score -1, myVote=-1', () => {
    const { value, tally } = computeOptimisticVote(
      { score: 2, upvotes: 2, downvotes: 0, myVote: null },
      'down',
    );
    expect(value).toBe(-1);
    expect(tally).toEqual({ score: 1, upvotes: 2, downvotes: 1, myVote: -1 });
  });

  it('derives score from up/down when the input omits it', () => {
    const { tally } = computeOptimisticVote({ upvotes: 5, downvotes: 2, myVote: null }, 'up');
    expect(tally.score).toBe(4);
    expect(tally.upvotes).toBe(6);
    expect(tally.downvotes).toBe(2);
  });
});
