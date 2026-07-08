import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Regression tests for fetchOrgs() network behavior.
 *
 * Before this fix, fetchOrgs() unconditionally hit `/api/orgs` on the local
 * server. In remote-only setups (Vite dev client pointed at a remote Agent
 * Hub) there is nothing listening on localhost:3051, so the Vite proxy
 * logged an ECONNREFUSED for every page mount. The fix gates the fetch on
 * `getConnectionConfig().mode === 'remote'` — the merged org list is still
 * returned from localStorage.
 */

const CONNECTION_KEY = 'agent-hub-connection';
const REMOTE_ORGS_KEY = 'agent-hub-remote-orgs';
const ACTIVE_ORG_KEY = 'agent-hub-active-org';
const JWT_KEY = 'agent-hub-jwt';

function clearAllOrgState() {
  localStorage.removeItem(CONNECTION_KEY);
  localStorage.removeItem(REMOTE_ORGS_KEY);
  localStorage.removeItem(ACTIVE_ORG_KEY);
  localStorage.removeItem(JWT_KEY);
  // Wipe any lingering electronAPI stub from other tests.
  delete (window as any).electronAPI;
}

describe('fetchOrgs — connection-mode gating', () => {
  beforeEach(() => {
    clearAllOrgState();
    vi.resetModules();
  });

  afterEach(() => {
    clearAllOrgState();
    vi.restoreAllMocks();
  });

  it('does NOT call fetch when connection mode is remote', async () => {
    localStorage.setItem(
      CONNECTION_KEY,
      JSON.stringify({ mode: 'remote', remoteUrl: 'https://hub.example.com', apiKey: '' }),
    );
    localStorage.setItem(
      REMOTE_ORGS_KEY,
      JSON.stringify([
        {
          id: 'remote-1',
          name: 'Acme Prod',
          mode: 'remote',
          color: '#6366f1',
          remote_url: 'https://hub.example.com',
          api_key: '',
          created_at: '2026-04-01T00:00:00Z',
        },
      ]),
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called in remote mode');
    });

    const { fetchOrgs } = await import('./orgs.js');
    const result = await fetchOrgs();

    expect(fetchSpy!).not.toHaveBeenCalled();
    expect(result!.orgs).toHaveLength(1);
    expect(result!.orgs[0].id).toBe('remote-1');
    expect(result!.activeOrgId).toBe('remote-1');
  });

  it('DOES call fetch against /api/orgs in local mode', async () => {
    // Local is the default — no connection key needed.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'default', name: 'Default', mode: 'local', color: '#6366f1' }],
    } as any);

    const { fetchOrgs } = await import('./orgs.js');
    const result = await fetchOrgs();

    expect(fetchSpy!).toHaveBeenCalledTimes(1);
    const [url] = (fetchSpy as any).mock.calls[0];
    expect(url!).toBe('/api/orgs');
    expect(result!.orgs.some((o: any) => o.id === 'default')).toBe(true);
  });

  it('swallows fetch errors in local mode so the UI stays functional', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));

    const { fetchOrgs } = await import('./orgs.js');
    // Should not throw — local mode is resilient to a dead server.
    await expect(fetchOrgs()).resolves.toBeDefined();
    expect(fetchSpy!).toHaveBeenCalledTimes(1);
  });
});

/**
 * getActiveOrgApiId resolves the right org id to send on org-scoped read
 * endpoints. Remote-mode bookmarks have browser-generated ids that don't
 * exist on the remote server — the helper returns the `active` alias for
 * those. Local orgs pass through their real id.
 */
describe('getActiveOrgApiId', () => {
  beforeEach(() => {
    clearAllOrgState();
    vi.resetModules();
  });

  afterEach(() => {
    clearAllOrgState();
    vi.restoreAllMocks();
  });

  it('returns the real id for a local org', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'default', name: 'Default', mode: 'local', color: '#6366f1' }],
    } as any);

    const { fetchOrgs, getActiveOrgApiId } = await import('./orgs.js');
    await fetchOrgs();

    expect(getActiveOrgApiId()).toBe('default');
  });

  it('returns "active" for a remote-mode org bookmark', async () => {
    localStorage.setItem(
      CONNECTION_KEY,
      JSON.stringify({ mode: 'remote', remoteUrl: 'https://hub.example.com', apiKey: '' }),
    );
    localStorage.setItem(
      REMOTE_ORGS_KEY,
      JSON.stringify([
        {
          id: 'browser-random-xyz',
          name: 'Acme Prod',
          mode: 'remote',
          color: '#6366f1',
          remote_url: 'https://hub.example.com',
          api_key: '',
          created_at: '2026-04-01T00:00:00Z',
        },
      ]),
    );

    const { fetchOrgs, getActiveOrgApiId } = await import('./orgs.js');
    await fetchOrgs();

    // The bookmark's random id must NOT leak to the remote server.
    expect(getActiveOrgApiId()).toBe('active');
  });

  it('returns null when there is no active org', async () => {
    const { getActiveOrgApiId } = await import('./orgs.js');
    expect(getActiveOrgApiId()).toBeNull();
  });
});

/**
 * Auth header propagation — regression coverage for the SetupWizard 401.
 *
 * Background: when the server has JWT auth configured (an `auth.json` exists,
 * e.g. via `AGENT_HUB_DEFAULT_PASSWORD=auto` on a deployed instance), every
 * call into `/api/orgs` runs through the JWT middleware. Before this fix the
 * org helpers in this module fired bare fetches with no `Authorization`
 * header, which the middleware rejected with 401 — blocking the
 * "Create Your Organization" wizard step even after the user had signed in.
 *
 * Each test below seeds a JWT in localStorage and asserts the helper attaches
 * `Authorization: Bearer <token>` to the outgoing request.
 */
describe('orgs.js — auth header propagation', () => {
  beforeEach(() => {
    clearAllOrgState();
    vi.resetModules();
    // Seed a non-expired JWT so getAuthHeaders() returns a Bearer header.
    localStorage.setItem(
      JWT_KEY,
      JSON.stringify({
        token: 'jwt-token-abc',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        user: { id: 'u1', username: 'admin', role: 'Owner' },
      }),
    );
  });

  afterEach(() => {
    clearAllOrgState();
    vi.restoreAllMocks();
  });

  function authHeaderOf(call: any) {
    const [, init] = call;
    const headers = init?.headers ?? {};
    return headers.Authorization ?? headers.authorization;
  }

  it('createOrg() sends the JWT bearer header on POST /api/orgs', async () => {
    // createOrg triggers fetchOrgs() on success, so the GET reload must
    // return an array shape — otherwise allOrgs() blows up on `[..._localOrgs]`.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (
      _url: any,
      init?: any,
    ) => {
      if (init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ id: 'new-org', name: 'Acme', mode: 'local' }) as any,
        };
      }
      return { ok: true, json: async () => [] as any };
    }) as any);

    const { createOrg } = await import('./orgs.js');
    await createOrg({ name: 'Acme', mode: 'local' });

    const createCall = (fetchSpy as any).mock.calls.find(
      ([url, init]: any) => url === '/api/orgs' && init?.method === 'POST',
    );
    expect(createCall!).toBeTruthy();
    expect(authHeaderOf(createCall)).toBe('Bearer jwt-token-abc');
  });

  it('fetchOrgs() sends the JWT bearer header on GET /api/orgs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [],
    } as any);

    const { fetchOrgs } = await import('./orgs.js');
    await fetchOrgs();

    expect(fetchSpy!).toHaveBeenCalledTimes(1);
    expect(authHeaderOf((fetchSpy as any).mock.calls[0])).toBe('Bearer jwt-token-abc');
  });

  it('updateOrg() sends the JWT bearer header on PUT /api/orgs/:id', async () => {
    // updateOrg also calls fetchOrgs() after success — return an array on GET.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (
      _url: any,
      init?: any,
    ) => {
      if (init?.method === 'PUT') {
        return {
          ok: true,
          json: async () => ({ id: 'org-1', name: 'Renamed', mode: 'local' }) as any,
        };
      }
      return { ok: true, json: async () => [] as any };
    }) as any);

    const { updateOrg } = await import('./orgs.js');
    await updateOrg('org-1', { name: 'Renamed' });

    const putCall = (fetchSpy as any).mock.calls.find(
      ([url, init]: any) => url === '/api/orgs/org-1' && init?.method === 'PUT',
    );
    expect(putCall!).toBeTruthy();
    expect(authHeaderOf(putCall)).toBe('Bearer jwt-token-abc');
  });
});
