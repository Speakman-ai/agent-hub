// Pure voting logic shared by the web and mobile Customer Support Voting tab
// (SPEC-3: one implementation in shared/, the platform seam injected by each
// client). A votable item is a `feature_request` support ticket; the server
// keys one vote per (ticket, voter_key).
//
// The only platform-specific piece — persisting the per-device voter token — is
// NOT here: the web client reads it synchronously from localStorage and the
// mobile client reads it asynchronously from AsyncStorage. Both build their token
// helper from the `VOTER_KEY_STORAGE` key and `randomToken()` exported below, so
// the storage seam is injected rather than forked.

export const VOTER_KEY_STORAGE = 'agent-hub-voter-key';

/** Mint an opaque per-device voter token (no PII). */
export function randomToken(): string {
  const g: { crypto?: { randomUUID?: () => string } } = globalThis as any;
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID();
  }
  return `voter-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export type VoteDirection = 'up' | 'down';

export interface VoteTally {
  score: number;
  upvotes: number;
  downvotes: number;
  myVote: 1 | -1 | null;
}

export interface OptimisticVote {
  // The value to send: the target vote, or null to retract.
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
 * Compute the optimistic tally for pressing a direction. Pressing the same
 * direction you already voted retracts (value=null); pressing the opposite
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

/**
 * Sort the voting feed: highest score first, ties broken by newest first —
 * matching the server's ORDER BY so a WebSocket-patched row lands in the right
 * place without a refetch.
 */
export function sortVotingItems(list: any[]): any[] {
  return [...list].sort((a: any, b: any) => {
    const sa = Number(a?.voting?.score) || 0;
    const sb = Number(b?.voting?.score) || 0;
    if (sa !== sb) return sb - sa;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
}
