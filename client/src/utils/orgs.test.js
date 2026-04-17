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

function clearAllOrgState() {
  localStorage.removeItem(CONNECTION_KEY);
  localStorage.removeItem(REMOTE_ORGS_KEY);
  localStorage.removeItem(ACTIVE_ORG_KEY);
  // Wipe any lingering electronAPI stub from other tests.
  delete window.electronAPI;
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

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.orgs).toHaveLength(1);
    expect(result.orgs[0].id).toBe('remote-1');
    expect(result.activeOrgId).toBe('remote-1');
  });

  it('DOES call fetch against /api/orgs in local mode', async () => {
    // Local is the default — no connection key needed.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'default', name: 'Default', mode: 'local', color: '#6366f1' }],
    });

    const { fetchOrgs } = await import('./orgs.js');
    const result = await fetchOrgs();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/orgs');
    expect(result.orgs.some((o) => o.id === 'default')).toBe(true);
  });

  it('swallows fetch errors in local mode so the UI stays functional', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));

    const { fetchOrgs } = await import('./orgs.js');
    // Should not throw — local mode is resilient to a dead server.
    await expect(fetchOrgs()).resolves.toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
