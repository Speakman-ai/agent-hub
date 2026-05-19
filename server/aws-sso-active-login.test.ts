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
    expect(getActiveAwsSsoLogin()).toBeNull();
  });

  it('round-trips a registration', () => {
    const proc = makeFakeProc('A');
    setActiveAwsSsoLogin({ loginId: 'a', proc, projectId: 'p1', profile: 'dev' });
    expect(getActiveAwsSsoLogin()?.proc).toBe(proc);
    expect(getActiveAwsSsoLogin()?.loginId).toBe('a');
  });

  it('clearActiveAwsSsoLogin wipes the slot', () => {
    setActiveAwsSsoLogin({
      loginId: 'a',
      proc: makeFakeProc('A'),
      projectId: 'p1',
      profile: 'dev',
    });
    clearActiveAwsSsoLogin();
    expect(getActiveAwsSsoLogin()).toBeNull();
  });

  describe('clearActiveAwsSsoLoginIfOwner — identity guard', () => {
    it('clears the slot when the supplied proc owns it', () => {
      const procA = makeFakeProc('A');
      setActiveAwsSsoLogin({ loginId: 'a', proc: procA, projectId: 'p1', profile: 'dev' });
      const cleared = clearActiveAwsSsoLoginIfOwner(procA);
      expect(cleared).toBe(true);
      expect(getActiveAwsSsoLogin()).toBeNull();
    });

    it('is a no-op when a different proc owns the slot', () => {
      const procA = makeFakeProc('A');
      const procB = makeFakeProc('B');
      setActiveAwsSsoLogin({ loginId: 'b', proc: procB, projectId: 'p1', profile: 'dev' });
      const cleared = clearActiveAwsSsoLoginIfOwner(procA);
      expect(cleared).toBe(false);
      // Crucial: the registration of B must survive A's deferred reset.
      expect(getActiveAwsSsoLogin()?.proc).toBe(procB);
      expect(getActiveAwsSsoLogin()?.loginId).toBe('b');
    });

    it('is a no-op when the slot is already empty', () => {
      const cleared = clearActiveAwsSsoLoginIfOwner(makeFakeProc('A'));
      expect(cleared).toBe(false);
      expect(getActiveAwsSsoLogin()).toBeNull();
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
      setActiveAwsSsoLogin({ loginId: 'a', proc: procA, projectId: 'p1', profile: 'dev' });
      expect(getActiveAwsSsoLogin()?.proc).toBe(procA);

      // (2) New request kills A and registers B.
      clearActiveAwsSsoLogin(); // eager clear before the next setActive call
      setActiveAwsSsoLogin({ loginId: 'b', proc: procB, projectId: 'p1', profile: 'dev' });
      expect(getActiveAwsSsoLogin()?.proc).toBe(procB);

      // (3) procA's deferred close handler fires. Identity guard makes
      // it a no-op — procB's registration is preserved.
      clearActiveAwsSsoLoginIfOwner(procA);
      expect(getActiveAwsSsoLogin()?.proc).toBe(procB);
      expect(getActiveAwsSsoLogin()?.loginId).toBe('b');
    });
  });
});
