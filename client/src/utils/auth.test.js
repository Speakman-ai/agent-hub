import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getToken,
  getAuthRecord,
  setToken,
  clearToken,
  isAuthenticated,
  login,
  setup,
  getAuthStatus,
  logout,
  getUserRole,
  hasRole,
} from './auth.js';

function mockLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    _store: store,
  };
}

describe('auth token helpers', () => {
  beforeEach(() => {
    globalThis.localStorage = mockLocalStorage();
    globalThis.window = { electronAPI: undefined };
  });

  it('round-trips a token', () => {
    expect(getToken()).toBeNull();
    setToken({ token: 'abc.def.ghi', expiresAt: null, user: { username: 'owner' } });
    expect(getToken()).toBe('abc.def.ghi');
    expect(getAuthRecord()).toEqual({
      token: 'abc.def.ghi',
      expiresAt: null,
      user: { username: 'owner' },
    });
    expect(isAuthenticated()).toBe(true);
  });

  it('treats an expired token as missing and clears it', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    setToken({ token: 'expired.jwt', expiresAt: past });
    expect(getToken()).toBeNull();
    // Token was cleaned up by the getter on first access.
    expect(localStorage.getItem('agent-hub-jwt')).toBeNull();
  });

  it('accepts a future-dated token', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    setToken({ token: 'fresh.jwt', expiresAt: future });
    expect(getToken()).toBe('fresh.jwt');
  });

  it('clearToken removes the stored record', () => {
    setToken({ token: 'x' });
    clearToken();
    expect(getToken()).toBeNull();
    expect(isAuthenticated()).toBe(false);
  });

  it('ignores malformed localStorage contents', () => {
    localStorage.setItem('agent-hub-jwt', 'not-json');
    expect(getToken()).toBeNull();
    expect(getAuthRecord()).toBeNull();
  });
});

describe('auth network helpers', () => {
  beforeEach(() => {
    globalThis.localStorage = mockLocalStorage();
    globalThis.window = { electronAPI: undefined };
  });

  it('login stores the returned token on 200', async () => {
    const body = {
      token: 't1.t2.t3',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: { username: 'owner' },
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
    const result = await login({
      baseUrl: '/api',
      username: 'owner',
      password: 'correct',
    });
    expect(result.token).toBe('t1.t2.t3');
    expect(getToken()).toBe('t1.t2.t3');
  });

  it('login surfaces the server error message on 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Invalid username or password' }),
    });
    await expect(login({ baseUrl: '/api', username: 'owner', password: 'wrong' })).rejects.toThrow(
      /Invalid username/,
    );
    expect(getToken()).toBeNull();
  });

  it('setup stores the token on success', async () => {
    const body = {
      ok: true,
      token: 's1.s2.s3',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: { username: 'owner' },
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
    await setup({ baseUrl: '/api', username: 'owner', password: 'a-strong-password' });
    expect(getToken()).toBe('s1.s2.s3');
  });

  it('getAuthStatus returns parsed body', async () => {
    const body = { authConfigured: true, username: 'owner' };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
    expect(await getAuthStatus('/api')).toEqual(body);
  });

  it('getAuthStatus rejects when the request is aborted (timeout)', async () => {
    globalThis.fetch = vi.fn((_url, opts) => {
      return new Promise((_, reject) => {
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

  it('getAuthStatus passes through activeOrgIsLocal for local-mode orgs', async () => {
    const body = {
      authConfigured: true,
      username: 'owner',
      role: 'Owner',
      activeOrgIsLocal: true,
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
    const result = await getAuthStatus('/api');
    expect(result.activeOrgIsLocal).toBe(true);
    expect(result).toEqual(body);
  });

  it('getAuthStatus passes through activeOrgIsLocal:false for cloud orgs', async () => {
    const body = {
      authConfigured: true,
      username: 'owner',
      role: 'Owner',
      activeOrgIsLocal: false,
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
    const result = await getAuthStatus('/api');
    expect(result.activeOrgIsLocal).toBe(false);
  });

  it('logout drops the stored token', async () => {
    setToken({ token: 'x' });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await logout({ baseUrl: '/api' });
    expect(getToken()).toBeNull();
  });
});

describe('role helpers (Phase 2)', () => {
  beforeEach(() => {
    globalThis.localStorage = mockLocalStorage();
    globalThis.window = { electronAPI: undefined };
  });

  it('getUserRole returns null when no token stored', () => {
    expect(getUserRole()).toBeNull();
  });

  it('getUserRole reads the role from the stored user record', () => {
    setToken({
      token: 'abc.def.ghi',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: { username: 'owner', role: 'Owner' },
    });
    expect(getUserRole()).toBe('Owner');
  });

  it('hasRole respects the Owner > Admin > User hierarchy', () => {
    const future = new Date(Date.now() + 60_000).toISOString();

    setToken({ token: 't', expiresAt: future, user: { username: 'a', role: 'Owner' } });
    expect(hasRole('Owner')).toBe(true);
    expect(hasRole('Admin')).toBe(true);
    expect(hasRole('User')).toBe(true);

    setToken({ token: 't', expiresAt: future, user: { username: 'b', role: 'Admin' } });
    expect(hasRole('Owner')).toBe(false);
    expect(hasRole('Admin')).toBe(true);
    expect(hasRole('User')).toBe(true);

    setToken({ token: 't', expiresAt: future, user: { username: 'c', role: 'User' } });
    expect(hasRole('Owner')).toBe(false);
    expect(hasRole('Admin')).toBe(false);
    expect(hasRole('User')).toBe(true);
  });

  it('hasRole returns false when no role is stored', () => {
    expect(hasRole('User')).toBe(false);
    setToken({
      token: 't',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: { username: 'owner' }, // no role field (legacy token)
    });
    expect(hasRole('User')).toBe(false);
  });
});
