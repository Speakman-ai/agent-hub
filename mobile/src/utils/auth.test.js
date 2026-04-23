import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock AsyncStorage with an in-memory Map, mirroring the setupState test
// pattern. This needs to live above the auth.js import below.
vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map();
  return {
    default: {
      getItem: vi.fn(async (key) => (store.has(key) ? store.get(key) : null)),
      setItem: vi.fn(async (key, value) => {
        store.set(key, value);
      }),
      removeItem: vi.fn(async (key) => {
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
} from './auth.js';

async function resetStore() {
  await AsyncStorage.clear();
  await clearToken(); // also resets the in-memory mirror
}

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
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        user: { username: 'owner' },
      }),
    );
    // Mirror not yet loaded — sync getter should still return null.
    expect(getToken()).toBeNull();
    await loadAuthToken();
    expect(getToken()).toBe('persisted.jwt');
  });

  it('treats an expired token as missing on load and clears it from disk', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
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
    await new Promise((r) => setTimeout(r, 60));
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
});

describe('mobile auth network helpers', () => {
  beforeEach(async () => {
    await resetStore();
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
      json: async () => body,
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
      json: async () => ({ error: 'Invalid username or password' }),
    });
    await expect(
      login({ baseUrl: '/api', username: 'owner', password: 'wrong' }),
    ).rejects.toThrow(/Invalid username/);
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

  it('logout drops the stored token', async () => {
    await setToken({ token: 'x' });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await logout({ baseUrl: '/api' });
    expect(getToken()).toBeNull();
  });
});
