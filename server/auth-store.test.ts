import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync, writeFileSync } from 'fs';
import path from 'path';

// Point the auth store at a tmp dir (same pattern as routes/auth.test.ts).
let TMP_DIR = '';
vi.mock('./config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

const { getAuthRecord, saveAuthRecord, setAuthRole, reloadAuthRecord, setAuthFilePathForTests } =
  await import('./auth-store.js');

function freshTmpDir() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'auth-store-role-test-'));
  setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
  reloadAuthRecord();
}

describe('auth-store — role field', () => {
  beforeEach(() => {
    freshTmpDir();
  });

  it('saves the record with an explicit role', () => {
    const saved = saveAuthRecord({
      username: 'owner',
      passwordHash: 'hash',
      jwtSecret: 'secret',
      role: 'Owner',
    });
    expect(saved.role).toBe('Owner');
    reloadAuthRecord();
    expect(getAuthRecord()?.role).toBe('Owner');
  });

  it('defaults to Owner when role is omitted at save time', () => {
    saveAuthRecord({
      username: 'owner',
      passwordHash: 'hash',
      jwtSecret: 'secret',
    });
    reloadAuthRecord();
    expect(getAuthRecord()?.role).toBe('Owner');
  });

  it('migrates a pre-Phase-2 auth.json with no role field to Owner', () => {
    // Simulate the on-disk shape from before Phase 2 shipped.
    const legacyFile = path.join(TMP_DIR, 'auth.json');
    writeFileSync(
      legacyFile,
      JSON.stringify({
        username: 'legacy-owner',
        passwordHash: 'hash',
        jwtSecret: 'secret',
        createdAt: '2026-04-01',
      }),
    );
    reloadAuthRecord();
    const record = getAuthRecord();
    expect(record).not.toBeNull();
    expect(record?.role).toBe('Owner');
  });

  it('coerces a garbage role value back to Owner rather than locking out', () => {
    const legacyFile = path.join(TMP_DIR, 'auth.json');
    writeFileSync(
      legacyFile,
      JSON.stringify({
        username: 'owner',
        passwordHash: 'hash',
        jwtSecret: 'secret',
        role: 'Superuser', // not a valid Role
        createdAt: '2026-04-01',
      }),
    );
    reloadAuthRecord();
    expect(getAuthRecord()?.role).toBe('Owner');
  });
});

describe('setAuthRole', () => {
  beforeEach(() => {
    freshTmpDir();
    saveAuthRecord({
      username: 'owner',
      passwordHash: 'hash',
      jwtSecret: 'secret',
      role: 'Owner',
    });
  });

  it('refuses to demote the only Owner', () => {
    expect(() => setAuthRole('Admin')).toThrow(/Owner/);
    expect(() => setAuthRole('User')).toThrow(/Owner/);
    expect(getAuthRecord()?.role).toBe('Owner');
  });

  it('is a no-op when the requested role matches', () => {
    const res = setAuthRole('Owner');
    expect(res?.role).toBe('Owner');
  });

  it('returns null when no record is configured yet', () => {
    freshTmpDir(); // wipes the file
    expect(setAuthRole('Admin')).toBeNull();
  });
});
