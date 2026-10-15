import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync, readFileSync, readdirSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
vi.mock('./config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

const { initOrgsDb, setOrgsDbPathForTests, getOrgsDb } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const { __resetSecretCryptoForTests, __setSecretCryptoKeyFilePathForTests, encryptSecret } =
  await import('./secret-crypto.js');
const store = await import('./browser-profiles-store.js');
const {
  acquireBrowserProfileLease,
  renewBrowserProfileLease,
  releaseBrowserProfileLease,
  saveBrowserProfileState,
  loadBrowserProfileState,
  getBrowserProfile,
  getOrCreateBrowserProfile,
  deleteBrowserProfile,
  clearBrowserProfileState,
  listBrowserProfilesForUser,
  domainsFromStorageState,
  BrowserProfileDecryptError,
  BrowserProfileLeaseError,
} = store;

const SECRET_COOKIE = 'sess-cookie-value-do-not-leak';

function state() {
  return {
    cookies: [
      { name: 'sid', value: SECRET_COOKIE, domain: '.Example.com', path: '/' },
      { name: 'x', value: 'y', domain: 'app.example.org', path: '/' },
    ],
    origins: [
      { origin: 'https://mail.example.net', localStorage: [{ name: 'tok', value: 'ls-secret' }] },
    ],
  };
}

let key: { userId: string; agentId: string; projectId: string };
const T0 = 1_000_000;
const TTL = 60_000;

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'browser-profiles-test-'));
  __resetSecretCryptoForTests();
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  const user = createUser({ username: 'alice', passwordHash: 'x' });
  key = { userId: user.id, agentId: 'agent-a', projectId: 'proj-1' };
});

describe('browser-profiles-store: profiles and encryption', () => {
  it('scopes profiles by (user, agent, project)', () => {
    const bob = createUser({ username: 'bob', passwordHash: 'x' });
    const a = getOrCreateBrowserProfile(key);
    expect(getOrCreateBrowserProfile(key).id).toBe(a.id);
    expect(getOrCreateBrowserProfile({ ...key, userId: bob.id }).id).not.toBe(a.id);
    expect(getOrCreateBrowserProfile({ ...key, agentId: 'agent-b' }).id).not.toBe(a.id);
    expect(getOrCreateBrowserProfile({ ...key, projectId: 'proj-2' }).id).not.toBe(a.id);
    expect(listBrowserProfilesForUser(key.userId)).toHaveLength(3);
  });

  it('round-trips state and records domains', () => {
    acquireBrowserProfileLease(key, 'session-1', TTL, { now: T0 });
    const saved = saveBrowserProfileState(key, 'session-1', state(), { now: T0 + 1 });
    expect(saved.hasState).toBe(true);
    expect(saved.lastSavedAt).not.toBeNull();
    expect(saved.domains).toEqual(['app.example.org', 'example.com', 'mail.example.net']);
    expect(loadBrowserProfileState(key)).toEqual(state());
  });

  it('stores ciphertext only: no plaintext in the row or on disk', () => {
    acquireBrowserProfileLease(key, 'session-1', TTL, { now: T0 });
    saveBrowserProfileState(key, 'session-1', state(), { now: T0 });
    const raw = getOrgsDb()
      .prepare('SELECT storage_state_enc FROM browser_profiles WHERE user_id = ?')
      .get(key.userId) as { storage_state_enc: string };
    expect(raw.storage_state_enc.split(':')).toHaveLength(3);
    expect(raw.storage_state_enc).not.toContain(SECRET_COOKIE);
    getOrgsDb().pragma('wal_checkpoint(TRUNCATE)');
    for (const f of readdirSync(TMP_DIR)) {
      expect(readFileSync(path.join(TMP_DIR, f)).toString('latin1')).not.toContain(SECRET_COOKIE);
    }
  });

  it('returns null when nothing is saved', () => {
    expect(loadBrowserProfileState(key)).toBeNull();
    getOrCreateBrowserProfile(key);
    expect(loadBrowserProfileState(key)).toBeNull();
  });

  it('throws a typed error without the cause when the key changed', () => {
    acquireBrowserProfileLease(key, 'session-1', TTL, { now: T0 });
    saveBrowserProfileState(key, 'session-1', state(), { now: T0 });
    __setSecretCryptoKeyFilePathForTests(path.join(TMP_DIR, 'other.key'));
    expect(() => loadBrowserProfileState(key)).toThrow(BrowserProfileDecryptError);
  });

  it('does not echo decrypted content when the blob decrypts to bad JSON', () => {
    const p = getOrCreateBrowserProfile(key);
    getOrgsDb()
      .prepare('UPDATE browser_profiles SET storage_state_enc = ? WHERE id = ?')
      .run(encryptSecret(`{"cookies": ${SECRET_COOKIE}`), p.id);
    let err: unknown;
    try {
      loadBrowserProfileState(key);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BrowserProfileDecryptError);
    expect(String((err as Error).message)).not.toContain(SECRET_COOKIE);
    expect((err as Error).cause).toBeUndefined();
  });

  it('rejects a decrypted value that is not a storage state', () => {
    const p = getOrCreateBrowserProfile(key);
    getOrgsDb()
      .prepare('UPDATE browser_profiles SET storage_state_enc = ? WHERE id = ?')
      .run(encryptSecret('{"hello":1}'), p.id);
    expect(() => loadBrowserProfileState(key)).toThrow(BrowserProfileDecryptError);
  });

  it('clear and delete', () => {
    acquireBrowserProfileLease(key, 's', TTL, { now: T0 });
    saveBrowserProfileState(key, 's', state(), { now: T0 });
    clearBrowserProfileState(key);
    expect(loadBrowserProfileState(key)).toBeNull();
    expect(getBrowserProfile(key)!.domains).toEqual([]);
    expect(deleteBrowserProfile(key)).toBe(true);
    expect(getBrowserProfile(key)).toBeNull();
  });

  it('cascades on user delete', () => {
    getOrCreateBrowserProfile(key);
    getOrgsDb().prepare('DELETE FROM users WHERE id = ?').run(key.userId);
    expect(getBrowserProfile(key)).toBeNull();
  });

  it('refuses oversize state', () => {
    acquireBrowserProfileLease(key, 's', TTL, { now: T0 });
    const big = {
      cookies: [],
      origins: [
        { origin: 'https://a.test', blob: 'x'.repeat(store.MAX_BROWSER_STORAGE_STATE_BYTES) },
      ],
    };
    expect(() => saveBrowserProfileState(key, 's', big, { now: T0 })).toThrow(/exceeds/);
  });
});

describe('browser-profiles-store: write lease', () => {
  it('second holder is refused while the lease is live', () => {
    expect(acquireBrowserProfileLease(key, 'A', TTL, { now: T0 })).toEqual({
      acquired: true,
      expiresAt: T0 + TTL,
    });
    expect(acquireBrowserProfileLease(key, 'B', TTL, { now: T0 + 10 })).toEqual({
      acquired: false,
      holder: 'A',
      expiresAt: T0 + TTL,
    });
  });

  it('non-holder cannot save, renew or release', () => {
    acquireBrowserProfileLease(key, 'A', TTL, { now: T0 });
    expect(() => saveBrowserProfileState(key, 'B', state(), { now: T0 + 1 })).toThrow(
      BrowserProfileLeaseError,
    );
    expect(renewBrowserProfileLease(key, 'B', TTL, { now: T0 + 1 })).toBe(false);
    expect(releaseBrowserProfileLease(key, 'B')).toBe(false);
    expect(getBrowserProfile(key)!.leaseHolder).toBe('A');
    expect(loadBrowserProfileState(key)).toBeNull();
  });

  it('save without any lease is refused', () => {
    getOrCreateBrowserProfile(key);
    expect(() => saveBrowserProfileState(key, 'A', state(), { now: T0 })).toThrow(
      BrowserProfileLeaseError,
    );
  });

  it('re-acquire by the same holder extends the lease', () => {
    acquireBrowserProfileLease(key, 'A', TTL, { now: T0 });
    expect(acquireBrowserProfileLease(key, 'A', TTL, { now: T0 + 5 })).toEqual({
      acquired: true,
      expiresAt: T0 + 5 + TTL,
    });
  });

  it('renew extends a live lease', () => {
    acquireBrowserProfileLease(key, 'A', TTL, { now: T0 });
    expect(renewBrowserProfileLease(key, 'A', TTL, { now: T0 + TTL - 1 })).toBe(true);
    expect(getBrowserProfile(key)!.leaseExpiresAt).toBe(T0 + 2 * TTL - 1);
    expect(acquireBrowserProfileLease(key, 'B', TTL, { now: T0 + TTL + 1 }).acquired).toBe(false);
  });

  it('release frees the lease for the next holder', () => {
    acquireBrowserProfileLease(key, 'A', TTL, { now: T0 });
    expect(releaseBrowserProfileLease(key, 'A')).toBe(true);
    expect(getBrowserProfile(key)!.leaseHolder).toBeNull();
    expect(acquireBrowserProfileLease(key, 'B', TTL, { now: T0 + 1 }).acquired).toBe(true);
  });

  it('a crashed holder (no renew) loses the lease at expiry', () => {
    acquireBrowserProfileLease(key, 'A', TTL, { now: T0 });
    expect(acquireBrowserProfileLease(key, 'B', TTL, { now: T0 + TTL - 1 }).acquired).toBe(false);
    expect(acquireBrowserProfileLease(key, 'B', TTL, { now: T0 + TTL }).acquired).toBe(true);
    // The stale holder can neither renew nor overwrite the new holder's state.
    expect(renewBrowserProfileLease(key, 'A', TTL, { now: T0 + TTL + 1 })).toBe(false);
    expect(() => saveBrowserProfileState(key, 'A', state(), { now: T0 + TTL + 1 })).toThrow(
      BrowserProfileLeaseError,
    );
    saveBrowserProfileState(key, 'B', state(), { now: T0 + TTL + 1 });
    expect(loadBrowserProfileState(key)).toEqual(state());
  });

  it('an expired holder cannot renew even when nobody took over', () => {
    acquireBrowserProfileLease(key, 'A', TTL, { now: T0 });
    expect(renewBrowserProfileLease(key, 'A', TTL, { now: T0 + TTL })).toBe(false);
    expect(acquireBrowserProfileLease(key, 'A', TTL, { now: T0 + TTL }).acquired).toBe(true);
  });

  it('leases are per profile', () => {
    acquireBrowserProfileLease(key, 'A', TTL, { now: T0 });
    expect(
      acquireBrowserProfileLease({ ...key, agentId: 'agent-b' }, 'B', TTL, { now: T0 }).acquired,
    ).toBe(true);
  });
});

describe('domainsFromStorageState', () => {
  it('ignores malformed origins and empty domains', () => {
    expect(
      domainsFromStorageState({
        cookies: [{ domain: '' }, { domain: '..A.test' }],
        origins: [{ origin: 'not a url' }, { origin: 'https://A.test:8443' }],
      }),
    ).toEqual(['a.test']);
  });
});

describe('browser-profiles-store: per-domain clear', () => {
  it('summarizes and clears domains, emptying the blob when nothing is left', () => {
    acquireBrowserProfileLease(key, 'h', TTL, { now: T0 });
    saveBrowserProfileState(key, 'h', state(), { now: T0 });
    expect(store.summarizeBrowserProfileDomains(key)).toEqual([
      { domain: 'app.example.org', cookieCount: 1, hasSiteStorage: false },
      { domain: 'example.com', cookieCount: 1, hasSiteStorage: false },
      { domain: 'mail.example.net', cookieCount: 0, hasSiteStorage: true },
    ]);
    expect(store.clearBrowserProfileDomain(key, 'nope.test')).toBeNull();
    expect(store.clearBrowserProfileDomain(key, '.EXAMPLE.com')!.domains).toEqual([
      'app.example.org',
      'mail.example.net',
    ]);
    store.clearBrowserProfileDomain(key, 'app.example.org');
    const last = store.clearBrowserProfileDomain(key, 'mail.example.net')!;
    expect(last).toMatchObject({ domains: [], hasState: false });
    expect(loadBrowserProfileState(key)).toBeNull();
  });

  it('never returns another user profile by id', () => {
    const bob = createUser({ username: 'bob2', passwordHash: 'x' });
    const p = getOrCreateBrowserProfile(key);
    expect(store.getBrowserProfileForUser(key.userId, p.id)?.id).toBe(p.id);
    expect(store.getBrowserProfileForUser(bob.id, p.id)).toBeNull();
  });
});
