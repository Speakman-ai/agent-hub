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
const ROLE_RANK = { Owner: 3, Admin: 2, User: 1 };

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
export function hasRole(minRole) {
  const role = getUserRole();
  if (!role) return false;
  const actual = ROLE_RANK[role] ?? 0;
  const needed = ROLE_RANK[minRole] ?? 0;
  return actual >= needed;
}

/** Persist a new token record. */
export function setToken({ token, expiresAt, user }) {
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
export async function login({ baseUrl, username, password }) {
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

/** POST /api/auth/setup — first-run bootstrap of the single user. */
export async function setup({ baseUrl, username, password }) {
  const res = await fetch(`${baseUrl}/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

/** GET /api/auth/status — unauthenticated probe. */
export async function getAuthStatus(baseUrl) {
  const res = await fetch(`${baseUrl}/auth/status`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Auth status failed: ${res.status}`);
  return res.json();
}

/** POST /api/auth/logout — stateless; we just drop the local token. */
export async function logout({ baseUrl } = {}) {
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
