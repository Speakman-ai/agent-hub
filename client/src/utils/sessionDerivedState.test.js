import { describe, it, expect } from 'vitest';
import { isSessionAskModeEnabled, isSessionWorktreeEnabled } from './sessionDerivedState.js';

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
});
