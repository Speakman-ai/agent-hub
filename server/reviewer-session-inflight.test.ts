import { describe, it, expect } from 'vitest';
import type { Project, SessionRow } from './types.js';
import {
  parsePrNumberFromReviewSessionTitle,
  findInFlightReviewerSessionId,
} from './reviewer-session-inflight.js';

function projectWithReviewers(ids: string[]): Project {
  return {
    id: 'p1',
    name: 'P',
    agents: ids.map((id) => ({ id, name: id, role: 'reviewer' as const })),
  } as unknown as Project;
}

describe('reviewer-session-inflight', () => {
  describe('parsePrNumberFromReviewSessionTitle', () => {
    it('parses standard review session titles', () => {
      expect(parsePrNumberFromReviewSessionTitle('Review: PR #42 Fix thing')).toBe(42);
    });
    it('returns null for unrelated titles', () => {
      expect(parsePrNumberFromReviewSessionTitle('[Resolve PR #3] x')).toBeNull();
      expect(parsePrNumberFromReviewSessionTitle(null)).toBeNull();
    });
  });

  describe('findInFlightReviewerSessionId', () => {
    it('returns session id when PR matches and process is active', () => {
      const procs = new Map<string, unknown>();
      procs.set('sess-1', {} as never);
      const sessions: Record<string, SessionRow[]> = {
        'rev-1': [{ id: 'sess-1', agent_id: 'rev-1', name: 'Review: PR #7 Title' } as SessionRow],
      };
      const id = findInFlightReviewerSessionId(
        projectWithReviewers(['rev-1']),
        7,
        (agentId) => sessions[agentId] || [],
        procs as never,
      );
      expect(id).toBe('sess-1');
    });

    it('returns null when PR number differs', () => {
      const procs = new Map<string, unknown>();
      procs.set('sess-1', {} as never);
      const sessions: Record<string, SessionRow[]> = {
        'rev-1': [{ id: 'sess-1', agent_id: 'rev-1', name: 'Review: PR #8 X' } as SessionRow],
      };
      expect(
        findInFlightReviewerSessionId(
          projectWithReviewers(['rev-1']),
          7,
          (agentId) => sessions[agentId] || [],
          procs as never,
        ),
      ).toBeNull();
    });

    it('returns null when no active process', () => {
      const procs = new Map<string, unknown>();
      const sessions: Record<string, SessionRow[]> = {
        'rev-1': [{ id: 'sess-1', agent_id: 'rev-1', name: 'Review: PR #7 X' } as SessionRow],
      };
      expect(
        findInFlightReviewerSessionId(
          projectWithReviewers(['rev-1']),
          7,
          (agentId) => sessions[agentId] || [],
          procs as never,
        ),
      ).toBeNull();
    });
  });
});
