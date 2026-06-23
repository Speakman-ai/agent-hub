/**
 * JWT auth helpers for the web client.
 *
 * Phase 1 single-user model:
 *   - The server issues a JWT after a successful POST /api/auth/login.
 *   - We persist the token (and its expiry) in localStorage under
 *     `agent-hub-jwt`. Both the REST helper (`getAuthHeaders`) and the
 *     WebSocket setup (`getWsUrl`) pick it up automatically.
 *   - The Electron preload, when present, mirrors the token to the main
 *     process so webRequest interception can inject the Authorization
 *     header on every request (matching how X-API-Key works today).
 */

const STORAGE_KEY = 'agent-hub-jwt';

/**
 * Module-level cache for the `activeOrgIsLocal` flag returned by
 * `GET /api/auth/status`. Set by `AuthGate` when the status resolves.
 * In local-bundled mode (Electron / single-user self-host) the server
 * short-circuits auth, no JWT is ever written, and `hasRole()` returns
 * false for everyone — so consumers that need to show admin-equivalent UI
 * in local mode should check `isLocalMode()` in addition to `hasRole()`.
 */
let _activeOrgIsLocal = false;

/** Called by AuthGate once the /auth/status response is available. */
export function setActiveOrgIsLocal(val: any) {
  _activeOrgIsLocal = !!val;
}

/**
 * True when the active org is running in local mode (no JWT required).
 * Treat local-mode users as Admin-equivalent for UX visibility gates;
 * the server still enforces real permissions on every request.
 */
export function isLocalMode() {
  return _activeOrgIsLocal;
}

function safeGet() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.token !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Return the current JWT, or null if missing/expired. */
export function getToken() {
  const rec = safeGet();
  if (!rec) return null;
  if (rec.expiresAt) {
    const exp = new Date(rec.expiresAt).getTime();
    if (Number.isFinite(exp) && exp <= Date.now()) {
      clearToken();
      return null;
    }
  }
  return rec.token;
}

/** Return the cached { token, expiresAt, user } record, or null. */
export function getAuthRecord() {
  return safeGet();
}

/**
 * Role hierarchy — kept in sync with server/roles.ts. Higher number =
 * more privileged. `hasRole('Admin')` returns true for Owner and Admin,
 * false for User / anonymous.
 */
const ROLE_RANK = { Owner: 3, Admin: 2, User: 1 } as Record<string, any>;

/** Return the role embedded in the cached user record, or null. */
export function getUserRole() {
  const rec = safeGet();
  return rec?.user?.role || null;
}

/**
 * True iff the cached user's role is at least `minRole`. Useful for
 * hiding admin-only UI affordances. The server still enforces the
 * real gate — this is purely a UX hint.
 */
export function hasRole(minRole: any) {
  const role = getUserRole();
  if (!role) return false;
  const actual = ROLE_RANK[role] ?? 0;
  const needed = ROLE_RANK[minRole] ?? 0;
  return actual >= needed;
}

/** Persist a new token record. */
export function setToken({ token, expiresAt, user }: any) {
  const record = { token, expiresAt: expiresAt || null, user: user || null };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  // Mirror to Electron so the main process can inject the header.
  if (window.electronAPI?.saveAuthToken) {
    try {
      window.electronAPI.saveAuthToken(record);
    } catch {
      /* non-fatal — the React app can still send the header itself */
    }
  }
}

/** Drop the stored token. Used on logout and on 401 responses. */
export function clearToken() {
  localStorage.removeItem(STORAGE_KEY);
  if (window.electronAPI?.saveAuthToken) {
    try {
      window.electronAPI.saveAuthToken(null);
    } catch {
      /* ignore */
    }
  }
}

/** True iff a non-expired token is stored. */
export function isAuthenticated() {
  return !!getToken();
}

/**
 * POST /api/auth/login — returns the full server response on success,
 * throws on failure. Persists the token on 200.
 */
export async function login({ baseUrl, username, password }: any) {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Invalid username or password');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Login failed: ${res.status}`);
  }
  const data = await res.json();
  setToken(data);
  return data;
}

/**
 * POST /api/auth/setup — first-run bootstrap of the Owner account.
 *
 * When the server already has a global API key (`needsMigration`), the
 * same endpoint requires `X-API-Key` to prove break-glass ownership before
 * creating the Owner — not the long-term UI auth mechanism.
 */
export async function setup({ baseUrl, username, password, apiKey = '' }: any) {
  const res = await fetch(`${baseUrl}/auth/setup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Setup failed: ${res.status}`);
  }
  const data = await res.json();
  setToken(data);
  return data;
}

/**
 * GET /api/auth/status — unauthenticated probe.
 *
 * Returns the parsed JSON body as-is:
 *   {
 *     authConfigured: boolean,
 *     username: string | null,
 *     role: 'Owner' | 'Admin' | 'User' | null,
 *     jwtConfigured: boolean,
 *     apiKeyConfigured: boolean,
 *     needsMigration: boolean,
 *     activeOrgIsLocal: boolean,  // true when the active org is in local
 *                                 // mode and auth should be bypassed
 *   }
 *
 * Callers (e.g. AuthGate) consume `activeOrgIsLocal` to suppress the login
 * screen for local-mode orgs even when auth is globally configured.
 *
 * @param {string} baseUrl
 * @param {{ timeoutMs?: number }} [options] — `timeoutMs` defaults to 15s. Pass `0` to
 *   disable (only for tests). Stops the auth gate from spinning forever when the
 *   API is unreachable (e.g. Vite dev proxy to a server that is not running).
 */
export async function getAuthStatus(baseUrl: any, { timeoutMs = 15_000 }: any = {}) {
  const useTimeout = timeoutMs > 0;
  const controller = useTimeout ? new AbortController() : null;
  const timer = useTimeout && controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${baseUrl}/auth/status`, {
      headers: { 'Content-Type': 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res.ok) throw new Error(`Auth status failed: ${res.status}`);
    return res.json();
  } catch (err: any) {
    if (controller && err?.name === 'AbortError') {
      throw new Error('Auth status request timed out');
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** POST /api/auth/logout — stateless; we just drop the local token. */
export async function logout({ baseUrl }: any = {}) {
  const token = getToken();
  if (baseUrl && token) {
    // Best-effort; the server is stateless so failure doesn't matter.
    try {
      await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      /* ignore */
    }
  }
  clearToken();
}
