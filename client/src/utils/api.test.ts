import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./connection', () => ({
  getApiBase: () => '/api',
  getAuthHeaders: () => ({}),
}));

const clearToken = vi.fn();
vi.mock('./auth', () => ({
  getToken: () => 'jwt-token',
  clearToken: () => clearToken(),
}));

import { api } from './api';

const reload = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  clearToken.mockReset();
  reload.mockReset();
  sessionStorage.clear();
  // jsdom's location.reload is non-configurable and throws "Not
  // implemented" when called. `window.location` itself IS configurable, so
  // replace the whole object with a minimal stub carrying a spy reload.
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { href: 'http://localhost/', reload },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
  vi.restoreAllMocks();
});

function mockFetchOnce(status: number, body: unknown) {
  globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('fetchJSON dead-session handling', () => {
  it('treats a no_active_org_membership 403 as a dead session: clears the token and reloads', async () => {
    mockFetchOnce(403, {
      error: 'You are not a member of this org.',
      code: 'no_active_org_membership',
    });

    await expect(api.getProjects()).rejects.toThrow(/403/);
    expect(clearToken).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('leaves an ordinary permission 403 alone (no token clear, no reload)', async () => {
    mockFetchOnce(403, { error: 'Owner role required.' });

    await expect(api.getProjects()).rejects.toThrow(/403/);
    expect(clearToken).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('still clears the token and reloads on a 401', async () => {
    mockFetchOnce(401, { error: 'Token is no longer valid.' });

    await expect(api.getProjects()).rejects.toThrow(/401/);
    expect(clearToken).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
