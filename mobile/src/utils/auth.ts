import AsyncStorage from '@react-native-async-storage/async-storage';
/**
 * JWT auth helpers for the mobile app.
 *
 * Mirrors `client/src/utils/auth.js` but uses AsyncStorage (async). The
 * connection config module reads the cached token synchronously from an
 * in-memory mirror that is warmed on startup — see `loadAuthToken()`.
 */
const STORAGE_KEY = 'agent-hub-jwt';
const VAULT_KEY = 'agent-hub-jwt-by-origin';
let _cachedToken: any = null;
const _vault: Record<string, any> = {};
let _deadSessionListener: (() => void) | null = null;

/** Origin of an http(s) server URL, or null. */
export function authOriginOf(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

function tokenFresh(record: any): any | null {
  if (!record || typeof record.token !== 'string') return null;
  if (record.expiresAt) {
    const exp = new Date(record.expiresAt).getTime();
    if (Number.isFinite(exp) && exp <= Date.now()) return null;
  }
  return record;
}

// Every change to the active record or the vault happens synchronously, before
// any await, so an activation, sign-in or clear can never be undone by another
// call's continuation. Disk writes are queued and each one writes the state as
// it is when the write runs, so the last write always matches memory.
let _writes: Promise<void> = Promise.resolve();

function persist(): Promise<void> {
  const write = async () => {
    // Never write a vault that has not finished loading: it would drop the
    // other servers' logins still on disk.
    await ensureVault();
    await AsyncStorage.setItem(VAULT_KEY, JSON.stringify(_vault));
    if (_cachedToken) await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(_cachedToken));
    else await AsyncStorage.removeItem(STORAGE_KEY);
  };
  _writes = _writes.then(write, write);
  return _writes;
}

// Every public auth operation takes exactly one turn, synchronously, at the
// moment it is called, and every step it takes (including after awaits, and
// inside composite operations) commits with that same turn. A step commits
// only if no operation that started later has committed, so the newest
// request decides the active login however the awaits interleave. Never take
// a turn after an await: that would let a stale continuation look newest.
let _turns = 0;
let _committedTurn = 0;

function takeTurn(): number {
  return ++_turns;
}

/** Make `record` active for `turn`; false (and nothing changes) if a later turn already committed. */
function commitActive(turn: number, record: any): boolean {
  // Equal turns are later steps of the same operation.
  if (turn < _committedTurn) return false;
  _committedTurn = turn;
  _cachedToken = record;
  return true;
}

function setActive(record: any) {
  commitActive(takeTurn(), record);
}

// The vault is loaded from disk once, by one shared promise.
//
// Saved logins follow the same turn order as the active login, per origin:
// each entry remembers the turn that last wrote or removed it, and only that
// turn or a later one may change it. So a stale response (an older sign-in
// to the same server resolving after a newer one) cannot replace the newer
// saved login, while a late sign-in to another server is still remembered.
// What is on disk is older than any turn, so the load never overrides an
// origin changed in memory while it was reading.
let _vaultLoad: Promise<void> | null = null;
const _vaultTurn = new Map<string, number>();

function vaultSet(turn: number, origin: string, record: any): boolean {
  if ((_vaultTurn.get(origin) ?? 0) > turn) return false;
  _vaultTurn.set(origin, turn);
  _vault[origin] = record;
  return true;
}

function vaultDelete(turn: number, origin: string): boolean {
  if ((_vaultTurn.get(origin) ?? 0) > turn) return false;
  _vaultTurn.set(origin, turn);
  delete _vault[origin];
  return true;
}

function ensureVault(): Promise<void> {
  if (!_vaultLoad) {
    _vaultLoad = (async () => {
      try {
        const raw = await AsyncStorage.getItem(VAULT_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== 'object') return;
        for (const [origin, record] of Object.entries(parsed)) {
          if (_vaultTurn.has(origin)) continue;
          if (tokenFresh(record)) _vault[origin] = record;
        }
      } catch {
        /* ignore a corrupt vault — the active slot still loads */
      }
    })();
  }
  return _vaultLoad;
}

/**
 * The active token belongs to this server. An unscoped legacy token (no
 * origin) is treated as the current server's. A token stamped for another
 * origin does not.
 */
export function tokenBelongsTo(serverUrl: string | null | undefined): boolean {
  const origin = _cachedToken?.origin;
  if (!origin) return true;
  return origin === authOriginOf(serverUrl);
}

/** Raise the login gate when the server rejects the session. */
export function onDeadSession(listener: () => void): () => void {
  _deadSessionListener = listener;
  return () => {
    if (_deadSessionListener === listener) _deadSessionListener = null;
  };
}

export function notifyDeadSession() {
  _deadSessionListener?.();
}

/** Drop the in-memory vault so the next read comes from disk. */
export async function reloadAuthVault() {
  const turn = takeTurn();
  await _writes.catch(() => {});
  // Something newer changed the login while writes drained: keep it.
  if (!commitActive(turn, null)) return;
  for (const key of Object.keys(_vault)) delete _vault[key];
  _vaultLoad = null;
  _vaultTurn.clear();
  await ensureVault();
}

/**
 * Make the saved login for `serverUrl` the active token. Other servers' logins
 * stay in the vault. No saved login leaves the app signed out of this server
 * only.
 */
export async function activateAuthForServer(serverUrl: string | null | undefined) {
  await activateFor(takeTurn(), serverUrl);
}

async function activateFor(turn: number, serverUrl: string | null | undefined) {
  await ensureVault();
  const origin = authOriginOf(serverUrl);
  const record = origin ? tokenFresh(_vault[origin]) : null;
  // A sign-in, clear or later activation committed while the vault loaded:
  // it is newer than this request.
  if (!commitActive(turn, record)) return;
  if (origin && _vault[origin] && !record) vaultDelete(turn, origin);
  await persist();
}

/** Warm the in-memory mirror from AsyncStorage. Call on app startup. */
export async function loadAuthToken(serverUrl?: string | null) {
  // Anything that changes the active login while this reads disk (the vault
  // or the active slot) started later and wins.
  const turn = takeTurn();
  await ensureVault();
  const origin = authOriginOf(serverUrl);
  if (origin && _vault[origin]) {
    const record = tokenFresh(_vault[origin]);
    if (!commitActive(turn, record)) return _cachedToken;
    if (!record) vaultDelete(turn, origin);
    await persist();
    return record;
  }
  let parsed: any = null;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const record = tokenFresh(parsed);
  if (parsed && !record) {
    if (commitActive(turn, null)) await persist();
    return _cachedToken;
  }
  if (!record || (origin && record.origin && record.origin !== origin)) {
    commitActive(turn, null);
    return _cachedToken;
  }
  if (!commitActive(turn, record)) return _cachedToken;
  if (origin && !record.origin) {
    record.origin = origin;
    vaultSet(turn, origin, record);
  }
  await persist();
  return record;
}
/** Synchronously read the in-memory token. Returns null if missing/expired. */
export function getToken() {
  if (!_cachedToken) return null;
  if (_cachedToken.expiresAt) {
    const exp = new Date(_cachedToken.expiresAt).getTime();
    if (Number.isFinite(exp) && exp <= Date.now()) {
      setActive(null);
      persist().catch(() => {});
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
/** Persist a new token record, remembered for the server that issued it. */
export async function setToken(data: any) {
  await storeLogin(takeTurn(), data);
}

/**
 * Remember a login for the server that issued it, and make it active unless
 * an operation that started after `turn` has already committed (then it is
 * only saved for that server).
 */
async function storeLogin(turn: number, { token, expiresAt, user, origin }: any) {
  const stamped = authOriginOf(origin);
  const record: any = { token, expiresAt: expiresAt || null, user: user || null };
  if (stamped) record.origin = stamped;
  const active = commitActive(turn, record);
  const saved = stamped ? vaultSet(turn, stamped, record) : false;
  if (active || saved) await persist();
}

/**
 * Drop the active server's token. Logins saved for other servers stay. With
 * `onlyToken`, nothing happens unless that token is still the active one, so
 * a caller reacting to a rejected request cannot sign out a login activated
 * since it was sent. Resolves true only if the app is still signed out by this
 * clear once it is saved: a login activated meanwhile resolves false, so the
 * caller does not raise the login gate over it.
 */
export async function clearToken(onlyToken?: string | null): Promise<boolean> {
  return clearFor(takeTurn(), onlyToken);
}

async function clearFor(turn: number, onlyToken?: string | null): Promise<boolean> {
  const active = _cachedToken;
  if (onlyToken !== undefined && (!active || active.token !== onlyToken)) return false;
  if (!commitActive(turn, null)) return false;
  const origin = active?.origin;
  // Removed even before the vault has loaded (the turn marks the origin), so
  // the pending disk read cannot bring the cleared login back.
  if (origin && (!_vault[origin] || _vault[origin].token === active?.token)) {
    vaultDelete(turn, origin);
  }
  await persist();
  return _committedTurn === turn;
}

/**
 * Undo a sign-in whose response belongs to a server the app has since left:
 * drop the login that response stored, and only that one (the server switched
 * to may already be signed in), then restore the login saved for the current
 * server. One turn covers both steps, so a switch made while the clear is
 * saving wins over the restore.
 */
export async function discardStaleLogin(response: any, currentServerUrl: string | null) {
  const turn = takeTurn();
  const storedToken = typeof response?.token === 'string' ? response.token : null;
  if (storedToken) await clearFor(turn, storedToken);
  await activateFor(turn, currentServerUrl);
}
/** True iff a non-expired token is cached. */
export function isAuthenticated() {
  return !!getToken();
}
/** POST /api/auth/login. Stores the token on success. */
export async function login({ baseUrl, username, password }: any) {
  const turn = takeTurn();
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
  await storeLogin(turn, { ...data, origin: baseUrl });
  return data;
}
export async function completeMfaLogin({ baseUrl, challengeId, code }: any) {
  const turn = takeTurn();
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
  await storeLogin(turn, { ...data, origin: baseUrl });
  return data;
}
/** POST /api/auth/setup — first-run bootstrap. */
export async function setup({ baseUrl, username, password }: any) {
  const turn = takeTurn();
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
  await storeLogin(turn, { ...data, origin: baseUrl });
  return data;
}
export async function updateEmail({ baseUrl, email }: any) {
  const turn = takeTurn();
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
  await storeLogin(turn, { ...data, origin: baseUrl });
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
  const turn = takeTurn();
  const token = getToken();
  // Sign out locally first, while this login is still the active one: it is
  // cleared and its saved copy removed under this turn before anything can
  // interleave. A switch or a newer sign-in made while the server request
  // below is in flight is later and is left alone.
  const clearing = clearFor(turn, token ?? undefined);
  if (baseUrl && token) {
    try {
      await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {}
  }
  await clearing;
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
