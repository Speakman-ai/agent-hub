import { describe, it, expect, beforeEach } from 'vitest';
import type { ChildProcess } from 'child_process';
import {
  getActiveAwsSsoLogin,
  setActiveAwsSsoLogin,
  clearActiveAwsSsoLogin,
  clearActiveAwsSsoLoginIfOwner,
  __resetActiveAwsSsoLoginForTests,
} from './aws-sso-active-login.js';

/**
 * `ChildProcess` is a heavy class — we just need an opaque identity object
 * to play the proc role in the slot. The active-login store only ever
 * compares procs by reference identity, so a plain object cast is enough.
 */
function makeFakeProc(label: string): ChildProcess {
  return { __label: label } as unknown as ChildProcess;
}

describe('aws-sso-active-login slot', () => {
  beforeEach(() => {
    __resetActiveAwsSsoLoginForTests();
  });

  it('starts empty', () => {
    expect(getActiveAwsSsoLogin(null)).toBeNull();
  });

  it('round-trips a registration', () => {
    const proc = makeFakeProc('A');
    setActiveAwsSsoLogin(null, { loginId: 'a', proc, projectId: 'p1', profile: 'dev' });
    expect(getActiveAwsSsoLogin(null)?.proc).toBe(proc);
    expect(getActiveAwsSsoLogin(null)?.loginId).toBe('a');
  });

  it('clearActiveAwsSsoLogin wipes the slot', () => {
    setActiveAwsSsoLogin(null, {
      loginId: 'a',
      proc: makeFakeProc('A'),
      projectId: 'p1',
      profile: 'dev',
    });
    clearActiveAwsSsoLogin(null);
    expect(getActiveAwsSsoLogin(null)).toBeNull();
  });

  describe('clearActiveAwsSsoLoginIfOwner — identity guard', () => {
    it('clears the slot when the supplied proc owns it', () => {
      const procA = makeFakeProc('A');
      setActiveAwsSsoLogin(null, { loginId: 'a', proc: procA, projectId: 'p1', profile: 'dev' });
      const cleared = clearActiveAwsSsoLoginIfOwner(null, procA);
      expect(cleared).toBe(true);
      expect(getActiveAwsSsoLogin(null)).toBeNull();
    });

    it('is a no-op when a different proc owns the slot', () => {
      const procA = makeFakeProc('A');
      const procB = makeFakeProc('B');
      setActiveAwsSsoLogin(null, { loginId: 'b', proc: procB, projectId: 'p1', profile: 'dev' });
      const cleared = clearActiveAwsSsoLoginIfOwner(null, procA);
      expect(cleared).toBe(false);
      // Crucial: the registration of B must survive A's deferred reset.
      expect(getActiveAwsSsoLogin(null)?.proc).toBe(procB);
      expect(getActiveAwsSsoLogin(null)?.loginId).toBe('b');
    });

    it('is a no-op when the slot is already empty', () => {
      const cleared = clearActiveAwsSsoLoginIfOwner(null, makeFakeProc('A'));
      expect(cleared).toBe(false);
      expect(getActiveAwsSsoLogin(null)).toBeNull();
    });

    /**
     * Regression for the race described in PR #1055 review:
     *
     *   1. Request A spawns procA → slot = A.
     *   2. Request B arrives → kills procA, clears slot, spawns procB → slot = B.
     *   3. procA's deferred `close` handler fires AFTER (2).
     *
     * Pre-fix: step (3) wiped the slot, allowing a third request to bypass
     * the kill-the-old-one-first guard and leave procB + procC racing on
     * `~/.aws/sso/cache`. The identity guard means step (3) is a no-op
     * because procA no longer owns the slot — procB stays registered and
     * a subsequent request will correctly kill it before spawning.
     */
    it('preserves a successor registration when the previous proc closes late', () => {
      const procA = makeFakeProc('A');
      const procB = makeFakeProc('B');

      // (1) Register A.
      setActiveAwsSsoLogin(null, { loginId: 'a', proc: procA, projectId: 'p1', profile: 'dev' });
      expect(getActiveAwsSsoLogin(null)?.proc).toBe(procA);

      // (2) New request kills A and registers B.
      clearActiveAwsSsoLogin(null); // eager clear before the next setActive call
      setActiveAwsSsoLogin(null, { loginId: 'b', proc: procB, projectId: 'p1', profile: 'dev' });
      expect(getActiveAwsSsoLogin(null)?.proc).toBe(procB);

      // (3) procA's deferred close handler fires. Identity guard makes
      // it a no-op — procB's registration is preserved.
      clearActiveAwsSsoLoginIfOwner(null, procA);
      expect(getActiveAwsSsoLogin(null)?.proc).toBe(procB);
      expect(getActiveAwsSsoLogin(null)?.loginId).toBe('b');
    });
  });

  describe('per-user slots', () => {
    it("one user's login never kills or clears another user's", () => {
      const procA = makeFakeProc('A');
      const procB = makeFakeProc('B');
      setActiveAwsSsoLogin('user-a', {
        loginId: 'a',
        proc: procA,
        projectId: 'p1',
        profile: 'dev',
      });
      setActiveAwsSsoLogin('user-b', {
        loginId: 'b',
        proc: procB,
        projectId: 'p1',
        profile: 'dev',
      });

      expect(getActiveAwsSsoLogin('user-a')?.proc).toBe(procA);
      expect(getActiveAwsSsoLogin('user-b')?.proc).toBe(procB);
      expect(getActiveAwsSsoLogin(null)).toBeNull();

      expect(clearActiveAwsSsoLoginIfOwner('user-b', procA)).toBe(false);
      clearActiveAwsSsoLogin('user-a');
      expect(getActiveAwsSsoLogin('user-a')).toBeNull();
      expect(getActiveAwsSsoLogin('user-b')?.proc).toBe(procB);
    });
  });
});
