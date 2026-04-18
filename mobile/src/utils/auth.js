import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * JWT auth helpers for the mobile app.
 *
 * Mirrors `client/src/utils/auth.js` but uses AsyncStorage (async). The
 * connection config module reads the cached token synchronously from an
 * in-memory mirror that is warmed on startup — see `loadAuthToken()`.
 */

const STORAGE_KEY = 'agent-hub-jwt';

let _cachedToken = null;

/** Warm the in-memory mirror from AsyncStorage. Call on app startup. */
export async function loadAuthToken() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.token === 'string') {
        if (parsed.expiresAt) {
          const exp = new Date(parsed.expiresAt).getTime();
          if (Number.isFinite(exp) && exp <= Date.now()) {
            await clearToken();
            return null;
          }
        }
        _cachedToken = parsed;
        return parsed;
      }
    }
  } catch {}
  _cachedToken = null;
  return null;
}

/** Synchronously read the in-memory token. Returns null if missing/expired. */
export function getToken() {
  if (!_cachedToken) return null;
  if (_cachedToken.expiresAt) {
    const exp = new Date(_cachedToken.expiresAt).getTime();
    if (Number.isFinite(exp) && exp <= Date.now()) {
      _cachedToken = null;
      // Fire-and-forget disk cleanup.
      AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
      return null;
    }
  }
  return _cachedToken.token;
}

export function getAuthRecord() {
  return _cachedToken;
}

/** Persist a new token record. */
export async function setToken({ token, expiresAt, user }) {
  const record = { token, expiresAt: expiresAt || null, user: user || null };
  _cachedToken = record;
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(record));
}

/** Drop the stored token. */
export async function clearToken() {
  _cachedToken = null;
  await AsyncStorage.removeItem(STORAGE_KEY);
}

/** True iff a non-expired token is cached. */
export function isAuthenticated() {
  return !!getToken();
}

/** POST /api/auth/login. Stores the token on success. */
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
  await setToken(data);
  return data;
}

/** POST /api/auth/setup — first-run bootstrap. */
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
  await setToken(data);
  return data;
}

/** GET /api/auth/status — public probe. */
export async function getAuthStatus(baseUrl) {
  const res = await fetch(`${baseUrl}/auth/status`);
  if (!res.ok) throw new Error(`Auth status failed: ${res.status}`);
  return res.json();
}

/** POST /api/auth/logout — clears local token (stateless server). */
export async function logout({ baseUrl } = {}) {
  const token = getToken();
  if (baseUrl && token) {
    try {
      await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {}
  }
  await clearToken();
}
