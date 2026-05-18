import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { perUserCliHomePath } from './per-user-cli-home.js';
import {
  clearActiveCodexDeviceLogin,
  getActiveCodexDeviceLogin,
  hasPopulatedCodexDeviceAuth,
  isCodexDeviceLoginInProgress,
  perUserCodexHomePath,
  resetActiveCodexDeviceLoginsForTest,
  setActiveCodexDeviceLogin,
} from './per-user-codex-device-login.js';

function fakeProc(): import('child_process').ChildProcess {
  return new EventEmitter() as unknown as import('child_process').ChildProcess;
}

describe('per-user-codex-device-login', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'percodex-'));
    resetActiveCodexDeviceLoginsForTest();
  });

  afterEach(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    resetActiveCodexDeviceLoginsForTest();
  });

  describe('perUserCodexHomePath', () => {
    it('matches perUserCliHomePath("codex", uid, dataDir)', () => {
      expect(perUserCodexHomePath('alice', dataDir)).toBe(
        perUserCliHomePath('codex', 'alice', dataDir),
      );
    });

    it('isolates users', () => {
      expect(perUserCodexHomePath('alice', dataDir)).not.toBe(perUserCodexHomePath('bob', dataDir));
    });

    it('rejects path-traversal userIds', () => {
      expect(() => perUserCodexHomePath('../escape', dataDir)).toThrow(/invalid userId/);
    });
  });

  describe('active-login tracker', () => {
    it('tracks and clears per-user records', () => {
      expect(isCodexDeviceLoginInProgress('u1')).toBe(false);
      setActiveCodexDeviceLogin('u1', { proc: fakeProc(), loginId: 'L1' });
      expect(isCodexDeviceLoginInProgress('u1')).toBe(true);
      expect(getActiveCodexDeviceLogin('u1')?.loginId).toBe('L1');
      expect(clearActiveCodexDeviceLogin('u1')).toBe(true);
      expect(isCodexDeviceLoginInProgress('u1')).toBe(false);
    });

    it('clearActiveCodexDeviceLogin is a no-op when no record', () => {
      expect(clearActiveCodexDeviceLogin('nobody')).toBe(false);
    });

    it('loginId-scoped clear refuses to evict a different loginId', () => {
      setActiveCodexDeviceLogin('u2', { proc: fakeProc(), loginId: 'L-current' });
      // A stale `proc.on('close')` from a previous login attempt must not
      // wipe the active record.
      expect(clearActiveCodexDeviceLogin('u2', 'L-stale')).toBe(false);
      expect(isCodexDeviceLoginInProgress('u2')).toBe(true);
      // The current login can still be cleared with its own id.
      expect(clearActiveCodexDeviceLogin('u2', 'L-current')).toBe(true);
      expect(isCodexDeviceLoginInProgress('u2')).toBe(false);
    });

    it('two users are tracked independently', () => {
      setActiveCodexDeviceLogin('A', { proc: fakeProc(), loginId: 'a' });
      setActiveCodexDeviceLogin('B', { proc: fakeProc(), loginId: 'b' });
      clearActiveCodexDeviceLogin('A');
      expect(isCodexDeviceLoginInProgress('A')).toBe(false);
      expect(isCodexDeviceLoginInProgress('B')).toBe(true);
    });
  });

  describe('hasPopulatedCodexDeviceAuth', () => {
    function writeAuth(userId: string, body: unknown): void {
      const home = perUserCodexHomePath(userId, dataDir);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(home, 'auth.json'), JSON.stringify(body));
    }

    it('returns false when the per-user dir does not exist', () => {
      expect(hasPopulatedCodexDeviceAuth('never-logged-in', dataDir)).toBe(false);
    });

    it('returns false when the dir exists but auth.json is missing', () => {
      const home = perUserCodexHomePath('aborted', dataDir);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      expect(hasPopulatedCodexDeviceAuth('aborted', dataDir)).toBe(false);
    });

    it('returns true for chatgpt-mode auth.json', () => {
      writeAuth('u-chatgpt', { auth_mode: 'chatgpt', tokens: { access_token: 'x' } });
      expect(hasPopulatedCodexDeviceAuth('u-chatgpt', dataDir)).toBe(true);
    });

    it('returns true for apikey-mode auth.json', () => {
      writeAuth('u-apikey', { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-xyz' });
      expect(hasPopulatedCodexDeviceAuth('u-apikey', dataDir)).toBe(true);
    });

    it('returns false for malformed JSON', () => {
      const home = perUserCodexHomePath('bad-json', dataDir);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(home, 'auth.json'), '{not json}');
      expect(hasPopulatedCodexDeviceAuth('bad-json', dataDir)).toBe(false);
    });

    it('returns false for unknown auth_mode (forward-compat)', () => {
      writeAuth('u-unknown', { auth_mode: 'future-mode-we-have-not-heard-of' });
      expect(hasPopulatedCodexDeviceAuth('u-unknown', dataDir)).toBe(false);
    });

    it('returns false for an invalid userId (does not throw)', () => {
      expect(hasPopulatedCodexDeviceAuth('../escape', dataDir)).toBe(false);
    });
  });
});
