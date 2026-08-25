import AsyncStorage from '@react-native-async-storage/async-storage';
/**
 * JWT auth helpers for the mobile app.
 *
 * Mirrors `client/src/utils/auth.js` but uses AsyncStorage (async). The
 * connection config module reads the cached token synchronously from an
 * in-memory mirror that is warmed on startup — see `loadAuthToken()`.
 */
const STORAGE_KEY = 'agent-hub-jwt';
let _cachedToken: any = null;
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
export function needsEmailUpdate() {
  return !!_cachedToken?.user?.needsEmailUpdate;
}
const ROLE_RANK: Record<string, number> = { Owner: 3, Admin: 2, User: 1 };
/** Role embedded in the cached user record, or null. */
export function getUserRole(): string | null {
  return _cachedToken?.user?.role || null;
}
/**
 * True iff the cached user's role is at least `minRole`. Purely a UX hint for
 * hiding admin-only affordances — the server still enforces the real gate.
 */
export function hasRole(minRole: string): boolean {
  const role = getUserRole();
  if (!role) return false;
  return (ROLE_RANK[role] ?? 0) >= (ROLE_RANK[minRole] ?? 0);
}
/** Persist a new token record. */
export async function setToken({ token, expiresAt, user }: any) {
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
export async function login({ baseUrl, username, password }: any) {
  const email = typeof username === 'string' ? username.trim() : username;
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, username: email, password }),
  });
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Invalid email or password');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Login failed: ${res.status}`);
  }
  const data = await res.json();
  if (data?.mfaRequired) {
    return data;
  }
  await setToken(data);
  return data;
}
export async function completeMfaLogin({ baseUrl, challengeId, code }: any) {
  const res = await fetch(`${baseUrl}/auth/login/mfa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId, code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message =
      res.status === 429
        ? body.error || 'Too many MFA attempts. Try again later.'
        : body.error || `MFA verification failed: ${res.status}`;
    throw new Error(message);
  }
  const data = await res.json();
  await setToken(data);
  return data;
}
/** POST /api/auth/setup — first-run bootstrap. */
export async function setup({ baseUrl, username, password }: any) {
  const email = typeof username === 'string' ? username.trim() : username;
  const res = await fetch(`${baseUrl}/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, username: email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Setup failed: ${res.status}`);
  }
  const data = await res.json();
  await setToken(data);
  return data;
}
export async function updateEmail({ baseUrl, email }: any) {
  const token = getToken();
  const res = await fetch(`${baseUrl}/auth/me/email`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Email update failed: ${res.status}`);
  }
  const data = await res.json();
  await setToken(data);
  return data;
}
/** GET /api/auth/status — public probe. Pass `timeoutMs: 0` to disable the default 15s cap. */
export async function getAuthStatus(baseUrl: any, { timeoutMs = 15000 }: any = {}) {
  const useTimeout = timeoutMs > 0;
  const controller = useTimeout ? new AbortController() : null;
  const timer = useTimeout && controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${baseUrl}/auth/status`, {
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
/** POST /api/auth/logout — clears local token (stateless server). */
export async function logout({ baseUrl }: any = {}) {
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

export async function forgotPassword({ baseUrl, email }: any) {
  const res = await fetch(`${baseUrl}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Password reset request failed: ${res.status}`);
  }
  return res.json();
}

export async function resetPassword({ baseUrl, token, newPassword }: any) {
  const res = await fetch(`${baseUrl}/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, newPassword }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Password reset failed: ${res.status}`);
  }
  return res.json();
}
