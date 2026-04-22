import { describe, it, expect } from 'vitest';
import {
  isSessionAskModeEnabled,
  isSessionWorktreeEnabled,
  prependSessionDeduped,
} from './sessionDerivedState.js';

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
});
