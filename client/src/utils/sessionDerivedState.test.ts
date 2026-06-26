import { describe, it, expect } from 'vitest';
import {
  isSessionAskModeEnabled,
  isSessionWorktreeEnabled,
  isSessionWorkspaceReady,
  prependSessionDeduped,
  planCreatedSessionCaches,
} from './sessionDerivedState';

describe('sessionDerivedState', () => {
  describe('isSessionAskModeEnabled', () => {
    it('returns false when session is undefined (missing row must not imply ask mode)', () => {
      expect(isSessionAskModeEnabled(undefined)).toBe(false);
    });

    it('returns false when session is null', () => {
      expect(isSessionAskModeEnabled(null)).toBe(false);
    });

    it('returns false when ask_mode is 0 or missing', () => {
      expect(isSessionAskModeEnabled({ id: 'x', ask_mode: 0 })).toBe(false);
      expect(isSessionAskModeEnabled({ id: 'x' })).toBe(false);
    });

    it('returns true when ask_mode is non-zero', () => {
      expect(isSessionAskModeEnabled({ id: 'x', ask_mode: 1 })).toBe(true);
    });
  });

  describe('isSessionWorktreeEnabled', () => {
    it('defaults to enabled when session is undefined (matches server default)', () => {
      expect(isSessionWorktreeEnabled(undefined)).toBe(true);
    });

    it('returns false when use_worktree is 0', () => {
      expect(isSessionWorktreeEnabled({ id: 'x', use_worktree: 0 })).toBe(false);
    });

    it('returns true when use_worktree is 1 or missing on a row object', () => {
      expect(isSessionWorktreeEnabled({ id: 'x', use_worktree: 1 })).toBe(true);
      expect(isSessionWorktreeEnabled({ id: 'x' })).toBe(true);
    });
  });

  describe('isSessionWorkspaceReady', () => {
    it('is true when worktree is disabled', () => {
      expect(isSessionWorkspaceReady({ id: 'x', use_worktree: 0, worktree_path: null })).toBe(true);
    });

    it('is false when worktree is enabled but path is empty', () => {
      expect(isSessionWorkspaceReady({ id: 'x', use_worktree: 1, worktree_path: null })).toBe(
        false,
      );
      expect(isSessionWorkspaceReady({ id: 'x', use_worktree: 1, worktree_path: '  ' })).toBe(
        false,
      );
    });

    it('is true when worktree_path is set', () => {
      expect(
        isSessionWorkspaceReady({
          id: 'x',
          use_worktree: 1,
          worktree_path: '/wt/session-abc',
        }),
      ).toBe(true);
    });
  });

  describe('prependSessionDeduped', () => {
    const a = { id: 'a', name: 'One' };
    const b = { id: 'b', name: 'Two' };

    it('prepends when the id is new', () => {
      expect(prependSessionDeduped([b], a)).toEqual([a, b]);
    });

    it('returns the same array reference when the id already exists', () => {
      const prev = [a, b];
      expect(prependSessionDeduped(prev, { ...a, name: 'Renamed' })).toBe(prev);
    });

    it('ignores a session without id', () => {
      const prev = [a];
      expect(prependSessionDeduped(prev, {})).toBe(prev);
    });
  });

  describe('planCreatedSessionCaches', () => {
    const rowA = { id: 's-a' };
    const created = { id: 's-new' };

    it('caches the new session under the target agent without touching another agent', () => {
      // Creating a session for agent-2 while agent-1 is the loaded list must NOT
      // prepend the row onto agent-1's `sessions` (which would later be cached
      // under agent-1 — cross-agent pollution).
      const sessions = [rowA];
      const out = planCreatedSessionCaches({
        targetAgentId: 'agent-2',
        loadedSessionsAgentId: 'agent-1',
        session: created,
        sessionsByAgentId: { 'agent-1': [rowA] },
        sessions,
      });
      // agent-2's cache gains the new row.
      expect(out.sessionsByAgentId['agent-2']).toEqual([created]);
      // agent-1's cache entry is untouched.
      expect(out.sessionsByAgentId['agent-1']).toEqual([rowA]);
      // The live `sessions` array is returned by the SAME reference (no mutate).
      expect(out.sessions).toBe(sessions);
    });

    it('returns the SAME `sessions` reference when the list is not the target agent (no re-render)', () => {
      const sessions = [rowA];
      const out = planCreatedSessionCaches({
        targetAgentId: 'agent-2',
        loadedSessionsAgentId: 'agent-1',
        session: created,
        sessionsByAgentId: {},
        sessions,
      });
      expect(out.sessions).toBe(sessions);
    });

    it('updates the live `sessions` only when it belongs to the target agent', () => {
      const out = planCreatedSessionCaches({
        targetAgentId: 'agent-1',
        loadedSessionsAgentId: 'agent-1',
        session: created,
        sessionsByAgentId: { 'agent-1': [rowA] },
        sessions: [rowA],
      });
      expect(out.sessions).toEqual([created, rowA]);
      expect(out.sessionsByAgentId['agent-1']).toEqual([created, rowA]);
    });

    it('is a no-op for a missing agent id or session', () => {
      const state = { sessionsByAgentId: { x: [rowA] }, sessions: [rowA] };
      expect(
        planCreatedSessionCaches({
          targetAgentId: '',
          loadedSessionsAgentId: 'x',
          session: created,
          ...state,
        }),
      ).toEqual(state);
      expect(
        planCreatedSessionCaches({
          targetAgentId: 'x',
          loadedSessionsAgentId: 'x',
          session: {},
          ...state,
        }),
      ).toEqual(state);
    });
  });
});
