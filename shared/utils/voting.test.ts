import { describe, it, expect } from 'vitest';
import { computeOptimisticVote, sortVotingItems, randomToken } from './voting';

describe('computeOptimisticVote', () => {
  it('casts a fresh upvote (+1) from a clean tally', () => {
    const { value, tally } = computeOptimisticVote(
      { score: 0, upvotes: 0, downvotes: 0, myVote: null },
      'up',
    );
    expect(value).toBe(1);
    expect(tally).toEqual({ score: 1, upvotes: 1, downvotes: 0, myVote: 1 });
  });

  it('retracts when pressing the same direction already voted', () => {
    const { value, tally } = computeOptimisticVote(
      { score: 1, upvotes: 1, downvotes: 0, myVote: 1 },
      'up',
    );
    expect(value).toBeNull();
    expect(tally).toEqual({ score: 0, upvotes: 0, downvotes: 0, myVote: null });
  });

  it('flips an upvote to a downvote in one press', () => {
    const { value, tally } = computeOptimisticVote(
      { score: 1, upvotes: 1, downvotes: 0, myVote: 1 },
      'down',
    );
    expect(value).toBe(-1);
    expect(tally).toEqual({ score: -1, upvotes: 0, downvotes: 1, myVote: -1 });
  });

  it('derives score from counts when the tally omits it', () => {
    const { tally } = computeOptimisticVote({ upvotes: 3, downvotes: 1, myVote: null }, 'up');
    expect(tally).toEqual({ score: 3, upvotes: 4, downvotes: 1, myVote: 1 });
  });
});

describe('sortVotingItems', () => {
  it('orders by score desc, breaking ties by newest first', () => {
    const sorted = sortVotingItems([
      { id: 'a', created_at: '2026-01-01', voting: { score: 1 } },
      { id: 'b', created_at: '2026-01-03', voting: { score: 9 } },
      { id: 'c', created_at: '2026-01-02', voting: { score: 9 } },
    ]);
    expect(sorted.map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });

  it('treats a missing tally as score 0', () => {
    const sorted = sortVotingItems([
      { id: 'a', created_at: '2026-01-01' },
      { id: 'b', created_at: '2026-01-01', voting: { score: 2 } },
    ]);
    expect(sorted.map((i) => i.id)).toEqual(['b', 'a']);
  });
});

describe('randomToken', () => {
  it('produces a non-empty, distinct token each call', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).toBeTruthy();
    expect(typeof a).toBe('string');
    expect(a).not.toBe(b);
  });
});
