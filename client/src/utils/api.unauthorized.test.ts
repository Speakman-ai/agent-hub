import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api';
import { setToken, clearToken, isAuthenticated, setActiveOrgIsLocal } from './auth';

/**
 * Regression coverage for the SPA-401-trap bug.
 *
 * Before: `fetchJSON` only triggered the `clearToken + reload` recovery path
 * when `getJwt()` returned a non-null token. If the JWT was already missing
 * from localStorage (cleared, evicted, never written) and the server
 * responded 401, the recovery short-circuited, the error bubbled to a
 * silently-caught console.error in App.jsx's bootstrap, and the user was
 * trapped with an empty UI and no nav.
 *
 * After: any 401 triggers `clearToken + reload` exactly once per browser
 * tab. A sessionStorage marker prevents reload-loops on pathological
 * installs that 401 even after re-bootstrap. Local bundled mode skips the
 * reload entirely (AuthGate already bypasses LoginScreen).
 */
describe('api fetchJSON — 401 handling', () => {
  let fetchSpy: any;
  let reloadSpy: any;
  let originalLocation: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    // Stub window.location.reload — jsdom forbids reassigning location, so
    // we replace just the method.
    originalLocation = window.location;
    reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...originalLocation, reload: reloadSpy, href: originalLocation.href },
    });
    sessionStorage.clear();
    clearToken();
    setActiveOrgIsLocal(false);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
    sessionStorage.clear();
    clearToken();
    setActiveOrgIsLocal(false);
  });

  it('reloads on 401 when a JWT is present (stale token path)', async () => {
    setToken({ token: 'stale-jwt', expiresAt: null, user: { role: 'Owner' } });
    expect(isAuthenticated()).toBe(true);

    (fetchSpy as any).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Authentication required.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(api.getProjects()).rejects.toThrow(/401/);

    expect(reloadSpy!).toHaveBeenCalledTimes(1);
    expect(isAuthenticated()).toBe(false); // clearToken was called
  });

  it('reloads on 401 even when no JWT is present (the trap-fix path)', async () => {
    expect(isAuthenticated()).toBe(false);

    (fetchSpy as any).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Authentication required.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(api.getProjects()).rejects.toThrow(/401/);

    // The key assertion: reload fires even though getJwt() returned null.
    expect(reloadSpy!).toHaveBeenCalledTimes(1);
  });

  it('does not reload twice in a row on consecutive 401s within the same tab', async () => {
    (fetchSpy as any).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Authentication required.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(api.getProjects()).rejects.toThrow(/401/);
    await expect(api.getAgents()).rejects.toThrow(/401/);

    // First 401 reloads; second is suppressed by the sessionStorage marker.
    // This protects against reload-loop on installs that 401 even after
    // re-bootstrap (e.g. apiKey-only server that's misconfigured).
    expect(reloadSpy!).toHaveBeenCalledTimes(1);
  });

  it('clears the reload marker after a successful request so future 401s reload again', async () => {
    // First 401 — sets the marker, reloads.
    (fetchSpy as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Authentication required.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(api.getProjects()).rejects.toThrow(/401/);
    expect(reloadSpy!).toHaveBeenCalledTimes(1);

    // Successful request — clears the marker.
    (fetchSpy as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await api.getProjects();

    // Second 401 in the same tab — reloads again (marker was cleared).
    (fetchSpy as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Authentication required.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(api.getAgents()).rejects.toThrow(/401/);
    expect(reloadSpy!).toHaveBeenCalledTimes(2);
  });

  it('does not reload on non-401 errors', async () => {
    (fetchSpy as any).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(api.getProjects()).rejects.toThrow(/500/);
    expect(reloadSpy!).not.toHaveBeenCalled();
  });

  it('does not reload on 401 from per-user engine auth probes', async () => {
    // SetupWizard / Account mount MyClaudeAuthSection even when the
    // caller has no resolvable authUserId (legacy apiKey, local-bypass
    // gap). Those panels treat 401 as an empty state — a global
    // clearToken+reload was kicking users back to LoginScreen mid-flow.
    setToken({ token: 'jwt-test', expiresAt: null, user: { role: 'Owner' } });
    (fetchSpy as any).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Authentication required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(api.getMyClaudeAuth()).rejects.toThrow(/401/);
    expect(reloadSpy!).not.toHaveBeenCalled();
    expect(isAuthenticated()).toBe(true);
  });

  it('does not reload on 401 in local bundled mode (avoids org-switch storm)', async () => {
    setActiveOrgIsLocal(true);
    setToken({ token: 'jwt-test', expiresAt: null, user: { role: 'Owner' } });
    (fetchSpy as any).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Authentication required.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(api.getProjects()).rejects.toThrow(/401/);
    expect(reloadSpy!).not.toHaveBeenCalled();
    expect(isAuthenticated()).toBe(true);
  });
});
