import { describe, it, expect } from 'vitest';
import { prAgentReviewProgress } from './prAgentReview';

const NOW = Date.parse('2026-10-01T12:00:00Z');

describe('prAgentReviewProgress', () => {
  it('is null when no agent review is running', () => {
    expect(prAgentReviewProgress(null)).toBeNull();
    expect(prAgentReviewProgress({ state: 'open' })).toBeNull();
    expect(prAgentReviewProgress({ state: 'open', agent_review_requested: false })).toBeNull();
  });

  it('is null on a closed PR even if a stale flag lingers', () => {
    expect(prAgentReviewProgress({ state: 'closed', agent_review_requested: true })).toBeNull();
  });

  it('reports elapsed time from agent_review_started_at', () => {
    const p = prAgentReviewProgress(
      {
        state: 'open',
        agent_review_requested: true,
        agent_review_started_at: '2026-10-01T11:57:00Z',
      },
      NOW,
    );
    expect(p).toEqual({
      active: true,
      label: 'Reviewing',
      detail: 'Agent review in progress · started 3m ago',
    });
  });

  it('handles fresh, hour-old, and missing start times', () => {
    const base = { state: 'open', agent_review_requested: true };
    expect(
      prAgentReviewProgress({ ...base, agent_review_started_at: '2026-10-01T11:59:40Z' }, NOW)
        ?.detail,
    ).toBe('Agent review in progress · started just now');
    expect(
      prAgentReviewProgress({ ...base, agent_review_started_at: '2026-10-01T10:30:00Z' }, NOW)
        ?.detail,
    ).toBe('Agent review in progress · started 1h ago');
    expect(prAgentReviewProgress(base, NOW)?.detail).toBe('Agent review in progress');
  });
});
