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

  it('logout drops the stored token', async () => {
    setToken({ token: 'x' });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await logout({ baseUrl: '/api' });
    expect(getToken()).toBeNull();
  });
});
