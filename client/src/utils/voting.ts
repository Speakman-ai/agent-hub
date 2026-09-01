// Anonymous voting helpers for the Customer Support Voting tab.
//
// A votable item is a `feature_request` support ticket; the server keys one
// vote per (ticket, voter_key). For anonymous browser voters the Hub mints a
// stable per-device token and persists it in localStorage (spec `vote-identity`
// path 3). No PII is involved — the token is an opaque UUID.

const VOTER_KEY_STORAGE = 'agent-hub-voter-key';

function randomToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `voter-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Read the per-browser voter token, minting and persisting one on first use.
 * Falls back to an in-memory token when localStorage is unavailable (private
 * mode / SSR) so voting still works for the session.
 */
export function getVoterKey(): string {
  try {
    const existing = localStorage.getItem(VOTER_KEY_STORAGE);
    if (existing && existing.trim()) return existing;
    const minted = randomToken();
    localStorage.setItem(VOTER_KEY_STORAGE, minted);
    return minted;
  } catch {
    return randomToken();
  }
}

export type VoteDirection = 'up' | 'down';

export interface VoteTally {
  score: number;
  upvotes: number;
  downvotes: number;
  myVote: 1 | -1 | null;
}

export interface OptimisticVote {
  // The value to PUT: the target vote, or null to retract.
  value: 1 | -1 | null;
  // The tally to show immediately, reconciled by the server response / WS event.
  tally: VoteTally;
}

function toTally(voting: any): VoteTally {
  const upvotes = Number(voting?.upvotes) || 0;
  const downvotes = Number(voting?.downvotes) || 0;
  const raw = voting?.myVote;
  const myVote = raw === 1 || raw === -1 ? raw : null;
  const score = typeof voting?.score === 'number' ? voting.score : upvotes - downvotes;
  return { score, upvotes, downvotes, myVote };
}

/**
 * Compute the optimistic tally for clicking a direction. Clicking the same
 * direction you already voted retracts (value=null); clicking the opposite
 * flips. Counts and score are recomputed from the current tally so the UI
 * updates without waiting for the round-trip.
 */
export function computeOptimisticVote(voting: any, direction: VoteDirection): OptimisticVote {
  const current = toTally(voting);
  const target: 1 | -1 = direction === 'up' ? 1 : -1;
  const nextMyVote: 1 | -1 | null = current.myVote === target ? null : target;

  const upvotes = current.upvotes - (current.myVote === 1 ? 1 : 0) + (nextMyVote === 1 ? 1 : 0);
  const downvotes =
    current.downvotes - (current.myVote === -1 ? 1 : 0) + (nextMyVote === -1 ? 1 : 0);

  return {
    value: nextMyVote,
    tally: { score: upvotes - downvotes, upvotes, downvotes, myVote: nextMyVote },
  };
}
