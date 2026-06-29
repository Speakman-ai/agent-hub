import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getToken,
  getAuthRecord,
  setToken,
  clearToken,
  isAuthenticated,
  login,
  completeMfaLogin,
  setup,
  forgotPassword,
  resetPassword,
  getAuthStatus,
  logout,
  getUserRole,
  hasRole,
} from './auth';

function mockLocalStorage() {
  const store = new Map();
  return {
    getItem: (k: any) => (store.has(k) ? store.get(k) : null),
    setItem: (k: any, v: any) => store.set(k, String(v)),
    removeItem: (k: any) => store.delete(k),
    clear: () => store.clear(),
    _store: store,
  };
}

describe('auth token helpers', () => {
  beforeEach(() => {
    (globalThis as any).localStorage = mockLocalStorage() as any;
    (globalThis as any).window = { electronAPI: undefined };
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
    (globalThis as any).localStorage = mockLocalStorage() as any;
    (globalThis as any).window = { electronAPI: undefined };
  });

  it('login stores the returned token on 200', async () => {
    const body = {
      token: 't1.t2.t3',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: { username: 'owner' },
    };
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as any);
    const result = await login({
      baseUrl: '/api',
      username: 'owner',
      password: 'correct',
    });
    expect(result!.token).toBe('t1.t2.t3');
    expect(getToken()).toBe('t1.t2.t3');
    expect((globalThis as any).fetch).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner', username: 'owner', password: 'correct' }),
    });
  });

  it('login surfaces the server error message on 401', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Invalid email or password' } as any),
    });
    await expect(login({ baseUrl: '/api', username: 'owner', password: 'wrong' })).rejects.toThrow(
      /Invalid email/,
    );
    expect(getToken()).toBeNull();
  });

  it('login returns pending MFA without storing a token', async () => {
    const body = {
      mfaRequired: true,
      challengeId: 'mfa_123',
      expiresAt: '2026-06-29T12:05:00.000Z',
    };
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as any);

    await expect(
      login({ baseUrl: '/api', username: 'owner', password: 'correct' }),
    ).resolves.toEqual(body);
    expect(getToken()).toBeNull();
  });

  it('completeMfaLogin stores the returned token and surfaces rate-limit errors', async () => {
    const body = {
      token: 'm1.m2.m3',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: { email: 'owner@example.com', role: 'Owner', mfaEnabled: true },
    };
    (globalThis as any).fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as any);

    await completeMfaLogin({ baseUrl: '/api', challengeId: 'mfa_123', code: '123456' });
    expect(getToken()).toBe('m1.m2.m3');
    expect((globalThis as any).fetch).toHaveBeenCalledWith('/api/auth/login/mfa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: 'mfa_123', code: '123456' }),
    });

    clearToken();
    (globalThis as any).fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ error: 'Too many MFA attempts. Try again later.' }),
    } as any);
    await expect(
      completeMfaLogin({ baseUrl: '/api', challengeId: 'mfa_123', code: '000000' }),
    ).rejects.toThrow(/Too many MFA attempts/i);
    expect(getToken()).toBeNull();
  });

  it('setup stores the token on success', async () => {
    const body = {
      ok: true,
      token: 's1.s2.s3',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: { username: 'owner' },
    };
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as any);
    await setup({ baseUrl: '/api', username: 'owner', password: 'a-strong-password' });
    expect(getToken()).toBe('s1.s2.s3');
  });

  it('getAuthStatus returns parsed body', async () => {
    const body = { authConfigured: true, username: 'owner' };
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as any);
    expect(await getAuthStatus('/api')).toEqual(body);
  });

  it('getAuthStatus rejects when the request is aborted (timeout)', async () => {
    (globalThis as any).fetch = vi.fn((_url: any, opts: any) => {
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

  it('getAuthStatus passes through activeOrgIsLocal for local-mode orgs', async () => {
    const body = {
      authConfigured: true,
      username: 'owner',
      role: 'Owner',
      activeOrgIsLocal: true,
    };
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as any);
    const result = await getAuthStatus('/api');
    expect(result!.activeOrgIsLocal).toBe(true);
    expect(result!).toEqual(body);
  });

  it('getAuthStatus passes through activeOrgIsLocal:false for cloud orgs', async () => {
    const body = {
      authConfigured: true,
      username: 'owner',
      role: 'Owner',
      activeOrgIsLocal: false,
    };
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as any);
    const result = await getAuthStatus('/api');
    expect(result!.activeOrgIsLocal).toBe(false);
  });

  it('logout drops the stored token', async () => {
    setToken({ token: 'x' });
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as any);
    await logout({ baseUrl: '/api' });
    expect(getToken()).toBeNull();
  });

  it('forgotPassword posts the account email without auth headers', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true }),
    } as any);
    await forgotPassword({ baseUrl: '/api', email: 'owner@example.com' });
    expect((globalThis as any).fetch).toHaveBeenCalledWith('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com' }),
    });
  });

  it('resetPassword posts the token and new password', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true }),
    } as any);
    await resetPassword({
      baseUrl: '/api',
      token: 'reset-token',
      newPassword: 'a-new-strong-password',
    });
    expect((globalThis as any).fetch).toHaveBeenCalledWith('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'reset-token', newPassword: 'a-new-strong-password' }),
    });
  });
});

describe('role helpers (Phase 2)', () => {
  beforeEach(() => {
    (globalThis as any).localStorage = mockLocalStorage() as any;
    (globalThis as any).window = { electronAPI: undefined };
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
