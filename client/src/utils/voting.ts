// Web adapter for the Customer Support Voting tab. The pure logic lives in
// shared/ (SPEC-3); this module injects the web platform seam — a synchronous
// per-browser voter token backed by localStorage.

import { VOTER_KEY_STORAGE, randomToken } from '@shared/utils/voting';

export {
  computeOptimisticVote,
  sortVotingItems,
  VOTER_KEY_STORAGE,
  randomToken,
} from '@shared/utils/voting';
export type { VoteDirection, VoteTally, OptimisticVote } from '@shared/utils/voting';

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
