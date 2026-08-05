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
 * After: a 401 tagged `code: 'invalid_session'` triggers `clearToken + reload`
 * exactly once per browser tab. A sessionStorage marker prevents reload-loops
 * on pathological installs that 401 even after re-bootstrap. Local bundled
 * mode skips the reload entirely (AuthGate already bypasses LoginScreen).
 *
 * The tag is load-bearing. An untagged 401 means something other than the
 * caller's credentials was rejected — see the "does not log out" cases at
 * the bottom.
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
      new Response(JSON.stringify({ error: 'Authentication required.', code: 'invalid_session' }), {
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
      new Response(JSON.stringify({ error: 'Authentication required.', code: 'invalid_session' }), {
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
      new Response(JSON.stringify({ error: 'Authentication required.', code: 'invalid_session' }), {
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
      new Response(JSON.stringify({ error: 'Authentication required.', code: 'invalid_session' }), {
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
      new Response(JSON.stringify({ error: 'Authentication required.', code: 'invalid_session' }), {
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
    //
    // The server tags exactly that case with `code: 'no_user_identity'`
    // (server/routes/auth.ts) — matching the real wire body matters here,
    // because the opt-out is scoped by the code rather than by callsite.
    // An untagged 401 from the same route IS a dead session; see
    // api.test.ts for both halves.
    setToken({ token: 'jwt-test', expiresAt: null, user: { role: 'Owner' } });
    (fetchSpy as any).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Authentication required', code: 'no_user_identity' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(api.getMyClaudeAuth()).rejects.toThrow(/401/);
    expect(reloadSpy!).not.toHaveBeenCalled();
    expect(isAuthenticated()).toBe(true);
  });

  it('does not reload on 401 in local bundled mode (avoids org-switch storm)', async () => {
    // `setActiveOrgIsLocal` carries the server's `activeOrgIsLocal` status
    // field, which is `AGENT_HUB_MODE === 'local'` — the DEPLOYMENT
    // identity, not any org's `mode` column. True here == Electron /
    // local self-host, where AuthGate never renders LoginScreen so a
    // reload cannot recover auth.
    // Tagged `invalid_session` on purpose: the deployment guard is what
    // this test pins, so the response has to be one the allowlist would
    // otherwise act on. An untagged 401 would pass for the wrong reason.
    setActiveOrgIsLocal(true);
    setToken({ token: 'jwt-test', expiresAt: null, user: { role: 'Owner' } });
    (fetchSpy as any).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Authentication required.', code: 'invalid_session' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(api.getProjects()).rejects.toThrow(/401/);
    expect(reloadSpy!).not.toHaveBeenCalled();
    expect(isAuthenticated()).toBe(true);
  });

  /**
   * The logout-loop bug. `App.tsx` refreshes an open-PR count on every load
   * for each project with a `githubRepo`. When the signed-in user had no
   * GitHub connection, that route answered 401 "Connect your GitHub account",
   * the blanket 401 rule wiped a perfectly valid JWT, and the reload dropped
   * the user on the login screen — every single time they signed in.
   */
  it('does not log out on an untagged 401 from an unconnected integration', async () => {
    setToken({ token: 'good-jwt', expiresAt: null, user: { role: 'Owner' } });

    (fetchSpy as any).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Connect your GitHub account in Settings → GitHub.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(api.getProjects()).rejects.toThrow(/401/);

    expect(reloadSpy!).not.toHaveBeenCalled();
    expect(isAuthenticated()).toBe(true);
  });

  it('still recovers a dead session on a HOSTED deployment (local-mode orgs are irrelevant)', async () => {
    // The counterpart to the case above, and the scenario raised in
    // review: a hosted deployment where some org has `mode: 'local'`.
    //
    // That cannot suppress recovery, because the flag never reflects org
    // state — the server derives it from AGENT_HUB_MODE alone and reports
    // false for a hosted deploy no matter what the orgs DB says (pinned by
    // "stays false on a hosted deployment even when the active org is
    // mode=local" in server/routes/auth.test.ts). So the client sees
    // false, and an expired/revoked JWT still clears the token and bounces
    // to LoginScreen rather than leaving the app authenticated-but-broken.
    setActiveOrgIsLocal(false);
    setToken({ token: 'jwt-expired', expiresAt: null, user: { role: 'Owner' } });
    (fetchSpy as any).mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'Token is no longer valid.', code: 'invalid_session' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(api.getProjects()).rejects.toThrow(/401/);
    expect(reloadSpy!).toHaveBeenCalledTimes(1);
    expect(isAuthenticated()).toBe(false);
  });

  it('does not log out on a 412 github_not_connected', async () => {
    setToken({ token: 'good-jwt', expiresAt: null, user: { role: 'Owner' } });

    (fetchSpy as any).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'Connect your GitHub account in Settings → GitHub.',
          code: 'github_not_connected',
        }),
        { status: 412, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(api.getProjects()).rejects.toThrow(/412/);

    expect(reloadSpy!).not.toHaveBeenCalled();
    expect(isAuthenticated()).toBe(true);
  });

  it('logs out on a 403 tagged no_active_org_membership', async () => {
    setToken({ token: 'good-jwt', expiresAt: null, user: { role: 'Owner' } });

    (fetchSpy as any).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'You are not a member of this org.',
          code: 'no_active_org_membership',
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(api.getProjects()).rejects.toThrow(/403/);

    expect(reloadSpy!).toHaveBeenCalledTimes(1);
    expect(isAuthenticated()).toBe(false);
  });

  it('does not log out on an ordinary permission 403', async () => {
    setToken({ token: 'good-jwt', expiresAt: null, user: { role: 'User' } });

    (fetchSpy as any).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Owner role required.' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(api.getProjects()).rejects.toThrow(/403/);

    expect(reloadSpy!).not.toHaveBeenCalled();
    expect(isAuthenticated()).toBe(true);
  });
});
