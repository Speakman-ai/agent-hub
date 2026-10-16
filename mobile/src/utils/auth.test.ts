// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from 'vitest';
// Mock AsyncStorage with an in-memory Map, mirroring the setupState test
// pattern. This needs to live above the auth.js import below.
vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map();
  return {
    default: {
      getItem: vi.fn(async (key: any) => (store.has(key) ? store.get(key) : null)),
      setItem: vi.fn(async (key: any, value: any) => {
        store.set(key, value);
      }),
      removeItem: vi.fn(async (key: any) => {
        store.delete(key);
      }),
      clear: vi.fn(async () => {
        store.clear();
      }),
      _store: store,
    },
  };
});
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  loadAuthToken,
  getToken,
  getAuthRecord,
  setToken,
  clearToken,
  isAuthenticated,
  login,
  setup,
  getAuthStatus,
  logout,
  completeMfaLogin,
  forgotPassword,
  resetPassword,
  getUserRole,
  hasRole,
  activateAuthForServer,
  reloadAuthVault,
  discardStaleLogin,
  loginTokenForServer,
  LOGOUT_TIMEOUT_MS,
} from './auth';
async function resetStore() {
  await clearToken();
  await AsyncStorage.clear();
  await reloadAuthVault();
}
describe('mobile auth role helpers', () => {
  beforeEach(async () => {
    await resetStore();
  });
  it('reads the cached user role and gates by rank', async () => {
    expect(getUserRole()).toBeNull();
    expect(hasRole('Admin')).toBe(false);
    await setToken({ token: 't', expiresAt: null, user: { username: 'admin', role: 'Admin' } });
    expect(getUserRole()).toBe('Admin');
    expect(hasRole('User')).toBe(true);
    expect(hasRole('Admin')).toBe(true);
    expect(hasRole('Owner')).toBe(false);
  });
  it('treats Owner as satisfying every lower role', async () => {
    await setToken({ token: 't', expiresAt: null, user: { username: 'owner', role: 'Owner' } });
    expect(hasRole('Admin')).toBe(true);
    expect(hasRole('Owner')).toBe(true);
  });
  it('denies admin gate for a plain User', async () => {
    await setToken({ token: 't', expiresAt: null, user: { username: 'u', role: 'User' } });
    expect(hasRole('Admin')).toBe(false);
  });
});
describe('mobile auth token helpers', () => {
  beforeEach(async () => {
    await resetStore();
  });
  it('round-trips a token through AsyncStorage + in-memory mirror', async () => {
    expect(getToken()).toBeNull();
    await setToken({
      token: 'abc.def.ghi',
      expiresAt: null,
      user: { username: 'owner' },
    });
    expect(getToken()).toBe('abc.def.ghi');
    expect(getAuthRecord()).toEqual({
      token: 'abc.def.ghi',
      expiresAt: null,
      user: { username: 'owner' },
    });
    expect(isAuthenticated()).toBe(true);
  });
  it('loadAuthToken warms the in-memory mirror from AsyncStorage', async () => {
    await AsyncStorage.setItem(
      'agent-hub-jwt',
      JSON.stringify({
        token: 'persisted.jwt',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        user: { username: 'owner' },
      }),
    );
    // Mirror not yet loaded — sync getter should still return null.
    expect(getToken()).toBeNull();
    await loadAuthToken();
    expect(getToken()).toBe('persisted.jwt');
  });
  it('treats an expired token as missing on load and clears it from disk', async () => {
    const past = new Date(Date.now() - 60000).toISOString();
    await AsyncStorage.setItem(
      'agent-hub-jwt',
      JSON.stringify({ token: 'expired.jwt', expiresAt: past }),
    );
    const loaded = await loadAuthToken();
    expect(loaded).toBeNull();
    expect(getToken()).toBeNull();
    // Cleanup removes the persisted record so we don't re-read it next boot.
    expect(await AsyncStorage.getItem('agent-hub-jwt')).toBeNull();
  });
  it('sync getToken() also expires stale tokens after load', async () => {
    const soon = new Date(Date.now() + 30).toISOString();
    await setToken({ token: 'short.jwt', expiresAt: soon });
    // Wait past expiry.
    await new Promise((r: any) => setTimeout(r, 60));
    expect(getToken()).toBeNull();
    expect(isAuthenticated()).toBe(false);
  });
  it('clearToken removes the stored record', async () => {
    await setToken({ token: 'x' });
    await clearToken();
    expect(getToken()).toBeNull();
    expect(isAuthenticated()).toBe(false);
    expect(await AsyncStorage.getItem('agent-hub-jwt')).toBeNull();
  });
  it('ignores malformed AsyncStorage contents on load', async () => {
    await AsyncStorage.setItem('agent-hub-jwt', 'not-json');
    const loaded = await loadAuthToken();
    expect(loaded).toBeNull();
    expect(getToken()).toBeNull();
  });
  it('remembers each server’s login and restores it when that server is active again', async () => {
    await setToken({
      token: 'token-a',
      user: { username: 'a' },
      origin: 'https://a.example',
    });
    await setToken({
      token: 'token-b',
      user: { username: 'b' },
      origin: 'https://b.example',
    });
    expect(getToken()).toBe('token-b');
    await activateAuthForServer('https://a.example');
    expect(getToken()).toBe('token-a');
    await clearToken();
    expect(getToken()).toBeNull();
    await activateAuthForServer('https://b.example');
    expect(getToken()).toBe('token-b');
    await reloadAuthVault();
    await loadAuthToken('https://a.example');
    expect(getToken()).toBeNull();
    await loadAuthToken('https://b.example');
    expect(getToken()).toBe('token-b');
  });
});
describe('mobile auth overlapping clear and switch', () => {
  beforeEach(async () => {
    await resetStore();
  });

  async function twoLogins() {
    await setToken({ token: 'token-a', origin: 'https://a.example' });
    await setToken({ token: 'token-b', origin: 'https://b.example' });
    await activateAuthForServer('https://a.example');
  }

  /** Holds the next AsyncStorage.setItem until `release` is called. */
  function holdNextWrite() {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const real = AsyncStorage.setItem.getMockImplementation();
    AsyncStorage.setItem.mockImplementationOnce(async (key, value) => {
      await gate;
      return real(key, value);
    });
    return release;
  }

  it('keeps a login activated while a clear is still persisting', async () => {
    await twoLogins();
    const release = holdNextWrite();
    const clearing = clearToken();
    expect(getToken()).toBeNull();
    const switching = activateAuthForServer('https://b.example');
    release();
    await Promise.all([clearing, switching]);
    expect(getToken()).toBe('token-b');

    // Disk agrees with memory: a cold start restores B and A's login is gone.
    await reloadAuthVault();
    expect(await loadAuthToken('https://b.example')).toMatchObject({ token: 'token-b' });
    await reloadAuthVault();
    expect(await loadAuthToken('https://a.example')).toBeNull();
  });

  it('reports no clear when another login is activated while the clear is saving', async () => {
    await twoLogins();
    const release = holdNextWrite();
    const clearing = clearToken('token-a');
    const switching = activateAuthForServer('https://b.example');
    release();
    await switching;
    expect(await clearing).toBe(false);
    expect(getToken()).toBe('token-b');
  });

  it('discarding a stale sign-in keeps the login of the server switched to', async () => {
    await setToken({ token: 'token-b', origin: 'https://b.example' });
    // A's sign-in stores its token; the switch to B lands while that write is held.
    const release = holdNextWrite();
    const signingIn = setToken({ token: 'token-a', origin: 'https://a.example' });
    const switching = activateAuthForServer('https://b.example');
    release();
    await Promise.all([signingIn, switching]);
    await discardStaleLogin({ token: 'token-a' }, 'https://b.example');
    expect(getToken()).toBe('token-b');
    // B's saved login survives on disk too.
    await reloadAuthVault();
    expect(await loadAuthToken('https://b.example')).toMatchObject({ token: 'token-b' });
  });

  it('discarding a stale sign-in drops it when it is still active', async () => {
    await setToken({ token: 'token-b', origin: 'https://b.example' });
    await setToken({ token: 'token-a', origin: 'https://a.example' });
    await discardStaleLogin({ token: 'token-a' }, 'https://b.example');
    expect(getToken()).toBe('token-b');
    await activateAuthForServer('https://a.example');
    expect(getToken()).toBeNull();
  });

  it('logout leaves a login activated while the logout request was in flight', async () => {
    await twoLogins();
    let finish!: () => void;
    globalThis.fetch = vi.fn(
      () =>
        new Promise((r) => {
          finish = () => r({ ok: true, json: async () => ({}) });
        }),
    );
    const loggingOut = logout({ baseUrl: 'https://a.example/api' });
    await activateAuthForServer('https://b.example');
    finish();
    await loggingOut;
    expect(getToken()).toBe('token-b');
    // The login that was logged out is gone, in memory and on disk.
    await activateAuthForServer('https://a.example');
    expect(getToken()).toBeNull();
    await reloadAuthVault();
    expect(await loadAuthToken('https://a.example')).toBeNull();
    expect((await loadAuthToken('https://b.example'))?.token).toBe('token-b');
  });

  it('logout keeps a newer sign-in to the same server made while it was in flight', async () => {
    await setToken({ token: 'token-a', origin: 'https://a.example' });
    let finish!: () => void;
    globalThis.fetch = vi.fn(
      () =>
        new Promise((r) => {
          finish = () => r({ ok: true, json: async () => ({}) });
        }),
    );
    const loggingOut = logout({ baseUrl: 'https://a.example/api' });
    await setToken({ token: 'token-a2', origin: 'https://a.example' });
    finish();
    await loggingOut;
    expect(getToken()).toBe('token-a2');
    await reloadAuthVault();
    expect((await loadAuthToken('https://a.example'))?.token).toBe('token-a2');
  });

  it('lets a switch made while stale-login cleanup is saving win over its restore', async () => {
    await setToken({ token: 'token-b', origin: 'https://b.example' });
    await setToken({ token: 'token-c', origin: 'https://c.example' });
    // The stale sign-in to A landed and is active; B is the selected server.
    await setToken({ token: 'token-a', origin: 'https://a.example' });
    const release = holdNextWrite();
    const cleanup = discardStaleLogin({ token: 'token-a' }, 'https://b.example');
    // The user switches to C while the cleanup's write is held.
    const switching = activateAuthForServer('https://c.example');
    release();
    await Promise.all([cleanup, switching]);
    expect(getToken()).toBe('token-c');
    await reloadAuthVault();
    expect((await loadAuthToken('https://b.example'))?.token).toBe('token-b');
  });

  it('saves a sign-in that resolves after a later switch without making it active', async () => {
    await setToken({ token: 'token-c', origin: 'https://c.example' });
    let respond!: () => void;
    globalThis.fetch = vi.fn(
      () =>
        new Promise((r) => {
          respond = () =>
            r({ ok: true, status: 200, json: async () => ({ token: 'token-a', user: {} }) });
        }),
    );
    const signingIn = login({ baseUrl: 'https://a.example/api', username: 'u', password: 'p' });
    await activateAuthForServer('https://c.example');
    respond();
    await signingIn;
    expect(getToken()).toBe('token-c');
    await activateAuthForServer('https://a.example');
    expect(getToken()).toBe('token-a');
  });

  it('keeps the newer of two same-server sign-ins that resolve in reverse order', async () => {
    const responders: Record<string, () => void> = {};
    globalThis.fetch = vi.fn(
      (_url: string, init: any) =>
        new Promise((r) => {
          const who = JSON.parse(init.body).email;
          responders[who] = () =>
            r({ ok: true, status: 200, json: async () => ({ token: `token-${who}`, user: {} }) });
        }),
    );
    const older = login({ baseUrl: 'https://a.example/api', username: 'old', password: 'p' });
    const newer = login({ baseUrl: 'https://a.example/api', username: 'new', password: 'p' });
    responders.new();
    await newer;
    responders.old();
    await older;
    expect(getToken()).toBe('token-new');
    // Restart: the saved login for the server is the newer one too.
    await reloadAuthVault();
    expect((await loadAuthToken('https://a.example'))?.token).toBe('token-new');
  });

  it('still remembers a late sign-in to another server', async () => {
    let respond!: () => void;
    globalThis.fetch = vi.fn(
      () =>
        new Promise((r) => {
          respond = () =>
            r({ ok: true, status: 200, json: async () => ({ token: 'token-a', user: {} }) });
        }),
    );
    const signingIn = login({ baseUrl: 'https://a.example/api', username: 'u', password: 'p' });
    await setToken({ token: 'token-b', origin: 'https://b.example' });
    respond();
    await signingIn;
    expect(getToken()).toBe('token-b');
    await reloadAuthVault();
    expect((await loadAuthToken('https://a.example'))?.token).toBe('token-a');
  });

  it('does not let a stale sign-in bring back a login cleared after it started', async () => {
    await setToken({ token: 'token-a', origin: 'https://a.example' });
    let respond!: () => void;
    globalThis.fetch = vi.fn(
      () =>
        new Promise((r) => {
          respond = () =>
            r({ ok: true, status: 200, json: async () => ({ token: 'token-stale', user: {} }) });
        }),
    );
    const signingIn = login({ baseUrl: 'https://a.example/api', username: 'u', password: 'p' });
    await clearToken('token-a');
    respond();
    await signingIn;
    expect(getToken()).toBeNull();
    await reloadAuthVault();
    expect(await loadAuthToken('https://a.example')).toBeNull();
  });

  it('only clears the expected token', async () => {
    await twoLogins();
    await activateAuthForServer('https://b.example');
    expect(await clearToken('token-a')).toBe(false);
    expect(getToken()).toBe('token-b');
    expect(await clearToken('token-b')).toBe(true);
    expect(getToken()).toBeNull();
  });

  it('does not let a slow startup read overwrite a newer activation', async () => {
    await setToken({ token: 'legacy' });
    await setToken({ token: 'token-b', origin: 'https://b.example' });
    await reloadAuthVault();
    let releaseRead!: () => void;
    const gate = new Promise<void>((r) => {
      releaseRead = r;
    });
    const realGet = AsyncStorage.getItem.getMockImplementation();
    AsyncStorage.getItem.mockImplementationOnce(async (key) => {
      await gate;
      return realGet(key);
    });
    const loading = loadAuthToken('https://unsaved.example');
    await activateAuthForServer('https://b.example');
    releaseRead();
    await loading;
    expect(getToken()).toBe('token-b');
  });
});
describe('mobile auth while the vault is still loading', () => {
  beforeEach(async () => {
    await resetStore();
  });

  /** Seed disk with logins for A and C, then drop memory so the next read is from disk. */
  async function seedDisk() {
    await setToken({ token: 'token-a', origin: 'https://a.example' });
    await setToken({ token: 'token-c', origin: 'https://c.example' });
    await reloadAuthVault();
  }

  /**
   * Reload from disk with the vault read held in flight. Resolves once the
   * read has started (memory is empty, the vault not yet loaded); call the
   * returned function to let it finish, then await the returned reload.
   */
  async function holdVaultRead() {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const reading = new Promise<void>((r) => {
      started = r;
    });
    const realGet = AsyncStorage.getItem.getMockImplementation();
    AsyncStorage.getItem.mockImplementation(async (key) => {
      if (key === 'agent-hub-jwt-by-origin') {
        started();
        await gate;
      }
      return realGet(key);
    });
    const reloading = reloadAuthVault();
    await reading;
    return async () => {
      release();
      await reloading;
      AsyncStorage.getItem.mockImplementation(realGet);
    };
  }

  it('keeps a login made before the vault read resolves, and the logins on disk', async () => {
    await seedDisk();
    const release = await holdVaultRead();
    const starting = loadAuthToken('https://a.example');
    const signingIn = setToken({ token: 'token-b', origin: 'https://b.example' });
    await release();
    await Promise.all([starting, signingIn]);
    expect(getToken()).toBe('token-b');
    // Disk now has all three: the pending read did not drop or overwrite any.
    await reloadAuthVault();
    expect((await loadAuthToken('https://b.example'))?.token).toBe('token-b');
    expect((await loadAuthToken('https://a.example'))?.token).toBe('token-a');
    expect((await loadAuthToken('https://c.example'))?.token).toBe('token-c');
  });

  it('lets a later server activation win over a startup load waiting on the vault', async () => {
    await seedDisk();
    const release = await holdVaultRead();
    const starting = loadAuthToken('https://a.example');
    const switching = activateAuthForServer('https://c.example');
    await release();
    await Promise.all([starting, switching]);
    expect(getToken()).toBe('token-c');
  });

  it('applies overlapping activations in the order they were requested', async () => {
    await seedDisk();
    const release = await holdVaultRead();
    const first = activateAuthForServer('https://a.example');
    const second = activateAuthForServer('https://c.example');
    await release();
    await Promise.all([first, second]);
    expect(getToken()).toBe('token-c');
  });

  it('does not bring back a login cleared before the vault read resolves', async () => {
    await seedDisk();
    const release = await holdVaultRead();
    // A fresh sign-in to A, then the server rejects it, all before the read lands.
    const signingIn = setToken({ token: 'token-a2', origin: 'https://a.example' });
    const clearing = clearToken('token-a2');
    await release();
    await signingIn;
    expect(await clearing).toBe(true);
    await activateAuthForServer('https://a.example');
    expect(getToken()).toBeNull();
    expect((await loadAuthToken('https://c.example'))?.token).toBe('token-c');
  });
});
describe('mobile auth network helpers', () => {
  beforeEach(async () => {
    await resetStore();
  });
  it('login stores the returned token on 200', async () => {
    const body = {
      token: 't1.t2.t3',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      user: { username: 'owner' },
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    });
    const result = await login({
      baseUrl: '/api',
      username: 'owner',
      password: 'correct',
    });
    expect(result.token).toBe('t1.t2.t3');
    expect(getToken()).toBe('t1.t2.t3');
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner', username: 'owner', password: 'correct' }),
    });
  });
  it('login returns pending MFA without storing a token', async () => {
    const body = {
      mfaRequired: true,
      challengeId: 'challenge-1',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      user: { username: 'owner', mfaEnabled: true },
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    });
    const result = await login({
      baseUrl: '/api',
      username: 'owner',
      password: 'correct',
    });
    expect(result).toEqual(body);
    expect(getToken()).toBeNull();
  });
  it('completeMfaLogin posts the challenge and stores the token', async () => {
    const body = {
      token: 'm1.m2.m3',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      user: { username: 'owner', mfaEnabled: true },
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    });
    await completeMfaLogin({ baseUrl: '/api', challengeId: 'challenge-1', code: '123456' });
    expect(getToken()).toBe('m1.m2.m3');
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/auth/login/mfa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: 'challenge-1', code: '123456' }),
    });
  });
  it('login surfaces the server error message on 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Invalid email or password' }),
    });
    await expect(login({ baseUrl: '/api', username: 'owner', password: 'wrong' })).rejects.toThrow(
      /Invalid email/,
    );
    expect(getToken()).toBeNull();
  });
  it('setup stores the token on success', async () => {
    const body = {
      ok: true,
      token: 's1.s2.s3',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      user: { username: 'owner' },
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    });
    await setup({
      baseUrl: '/api',
      username: 'owner',
      password: 'a-strong-password',
    });
    expect(getToken()).toBe('s1.s2.s3');
  });
  it('getAuthStatus returns parsed body', async () => {
    const body = { authConfigured: true, username: 'owner' };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    });
    expect(await getAuthStatus('/api')).toEqual(body);
  });
  it('getAuthStatus rejects when the request is aborted (timeout)', async () => {
    globalThis.fetch = vi.fn((_url: any, opts: any) => {
      return new Promise((_: any, reject: any) => {
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => {
            const e = new Error('Aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }
      });
    });
    await expect(getAuthStatus('/api', { timeoutMs: 30 })).rejects.toThrow(
      'Auth status request timed out',
    );
  });
  it('logout drops the stored token', async () => {
    await setToken({ token: 'x' });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await logout({ baseUrl: '/api' });
    expect(getToken()).toBeNull();
  });
  it('forgotPassword posts the account email', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await forgotPassword({ baseUrl: '/api', email: 'owner@example.com' });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com' }),
    });
  });
  it('resetPassword posts the token and new password', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await resetPassword({
      baseUrl: '/api',
      token: 'reset-token',
      newPassword: 'a-new-strong-password',
    });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'reset-token', newPassword: 'a-new-strong-password' }),
    });
  });
});

describe('loginTokenForServer', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('reads any saved server login without changing the active one', async () => {
    await setToken({ token: 'token-a', origin: 'https://a.example' });
    await setToken({ token: 'token-b', origin: 'https://b.example' });
    await activateAuthForServer('https://a.example');
    expect(await loginTokenForServer('https://b.example/')).toBe('token-b');
    expect(await loginTokenForServer('https://a.example')).toBe('token-a');
    expect(getToken()).toBe('token-a');
  });

  it('is null for servers never signed in to and for expired logins', async () => {
    await setToken({
      token: 'old',
      origin: 'https://c.example',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await loginTokenForServer('https://c.example')).toBeNull();
    expect(await loginTokenForServer('https://nope.example')).toBeNull();
    expect(await loginTokenForServer('')).toBeNull();
  });
});

describe('logout against a server that never answers', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('signs out locally and returns once the request times out', async () => {
    vi.useFakeTimers();
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as any;
    try {
      await setToken({ token: 'tok', origin: 'https://a.example' });
      const done = vi.fn();
      const out = logout({ baseUrl: 'https://a.example/api' }).then(done);
      await vi.advanceTimersByTimeAsync(LOGOUT_TIMEOUT_MS - 1);
      expect(getToken()).toBeNull();
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await out;
      expect(done).toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
      vi.useRealTimers();
    }
  });
});
