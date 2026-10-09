/**
 * Credential scoping for the Electron remote-mode header injector.
 *
 * The main process injects the cached JWT (or the connection's API key) into
 * every request to the configured remote host. The JWT file is a single slot,
 * so without scoping a token issued by one server is sent to whatever server
 * the connection points at next. Each saved record is stamped with the origin
 * it was issued for, and the injector only sends it back to that origin.
 */

export interface RemoteConnection {
  mode: string;
  remoteUrl: string;
  apiKey: string;
}

export interface ScopedAuthRecord {
  token: string;
  expiresAt?: string | null;
  /** Origin of the server that issued the token. */
  origin?: string;
}

export function urlOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

const WS_TO_HTTP: Record<string, string> = { 'ws:': 'http:', 'wss:': 'https:' };

/**
 * Origin of an outgoing request, for matching against the configured server.
 * A WebSocket handshake to the server (`wss://host` for an `https://host`
 * connection) is the same server, so ws/wss map to http/https; scheme and
 * port still have to match. Token issuers stay http(s)-only (`urlOrigin`).
 */
export function requestOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const httpScheme = WS_TO_HTTP[parsed.protocol];
    if (httpScheme) parsed.protocol = httpScheme;
    return urlOrigin(parsed.href);
  } catch {
    return null;
  }
}

/**
 * Stamp a token record with the origin of the page that saved it.
 *
 * The renderer persists the token from the page that just signed in, so the
 * sender frame's origin is the server that issued it. The connection config
 * is not: a server switch can rewrite it while a sign-in is still in flight,
 * and stamping from it would hand server A's token to server B. Anything the
 * caller put in `origin` is discarded; non-http(s) senders stay unscoped and
 * are therefore never injected.
 */
export function scopeAuthRecord<T extends ScopedAuthRecord>(
  record: T,
  senderOrigin: string | null | undefined,
): T {
  const origin = urlOrigin(senderOrigin);
  const { origin: _drop, ...rest } = record;
  return (origin ? { ...rest, origin } : rest) as T;
}

/** The record to persist for a `save-auth-token` IPC message, or null to clear. */
export function authRecordFromIpc(
  event: { senderFrame?: { origin?: string } | null },
  record: ScopedAuthRecord | null | undefined,
): ScopedAuthRecord | null {
  if (!record || typeof record.token !== 'string') return null;
  return scopeAuthRecord(record, event.senderFrame?.origin ?? null);
}

export function isAuthRecordUnexpired(
  record: ScopedAuthRecord | null | undefined,
  now = Date.now(),
): record is ScopedAuthRecord {
  if (!record || typeof record.token !== 'string') return false;
  if (record.expiresAt) {
    const exp = new Date(record.expiresAt).getTime();
    if (Number.isFinite(exp) && exp <= now) return false;
  }
  return true;
}

/**
 * Headers to add to a request in remote mode. Only requests to the configured
 * remote origin get credentials; the JWT is used only when it was issued by
 * that origin (unstamped records predate scoping and are never sent).
 */
export function remoteAuthHeaders(params: {
  connection: RemoteConnection;
  authRecord: ScopedAuthRecord | null;
  requestUrl: string;
  now?: number;
}): Record<string, string> {
  const { connection, authRecord, requestUrl } = params;
  if (connection.mode !== 'remote') return {};
  const remote = urlOrigin(connection.remoteUrl);
  if (!remote || requestOrigin(requestUrl) !== remote) return {};
  if (isAuthRecordUnexpired(authRecord, params.now) && authRecord.origin === remote) {
    return { Authorization: `Bearer ${authRecord.token}` };
  }
  if (connection.apiKey) return { 'X-API-Key': connection.apiKey };
  return {};
}
