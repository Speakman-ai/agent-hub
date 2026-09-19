export const VOTER_KEY_STORAGE = 'agent-hub-voter-key';

/** Opaque per-device voter token (no PII). Storage is injected by each client. */
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
  /** Target vote, or null to retract. */
  value: 1 | -1 | null;
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

/** Optimistic tally for a vote press. Same direction retracts; opposite flips. */
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

/** Highest score first, newest on ties. Matches the server ORDER BY. */
export function sortVotingItems(list: any[]): any[] {
  return [...list].sort((a: any, b: any) => {
    const sa = Number(a?.voting?.score) || 0;
    const sb = Number(b?.voting?.score) || 0;
    if (sa !== sb) return sb - sa;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
}
