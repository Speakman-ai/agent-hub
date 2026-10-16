/**
 * Turn a preview event URL into something the phone can load.
 *
 * The server often emits `http://localhost:<port>`. On a phone that name is
 * the phone, so swap the loopback host for the Hub the app is signed into
 * and keep the published port. Proxy paths (`/preview/proxy`) stay on the
 * Hub origin. Relative paths are joined to that origin.
 */

const LOOPBACK_HOST = /^(localhost|0\.0\.0\.0|::1|\[::1\]|127(?:\.\d{1,3}){3})$/i;

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOST.test(hostname.replace(/^\[|\]$/g, ''));
}

export function previewLoadUrl(raw: string, serverBase: string): string {
  if (!raw || typeof raw !== 'string') return '';
  const base = (serverBase || '').replace(/\/+$/, '');
  if (raw.startsWith('/') && base) return `${base}${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  if (!base) return parsed.toString();
  let origin: URL;
  try {
    origin = new URL(base);
  } catch {
    return parsed.toString();
  }
  if (isLoopback(parsed.hostname) && !isLoopback(origin.hostname)) {
    parsed.hostname = origin.hostname;
  }
  return parsed.toString();
}

/** The destinations the Hub vouches for, for one session's preview. */
export interface PreviewTicketScope {
  /** The Hub the app is signed into. */
  hubBase: string;
  sessionId: string;
  /** The preview URL the Hub reported for this session (may be a session subdomain). */
  reportedUrl?: string | null;
}

function parseHttp(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

/** `<sessionId>` or `<port>--<sessionId>`, the session-subdomain label forms. */
function labelIsSession(label: string, sessionId: string): boolean {
  const id = sessionId.toLowerCase();
  const l = label.toLowerCase();
  return l === id || (/^\d+--/.test(l) && l.slice(l.indexOf('--') + 2) === id);
}

/** The base domain of a session-subdomain host for this session, or null. */
function sessionSubdomainBase(host: string, sessionId: string): string | null {
  const dot = host.indexOf('.');
  if (dot <= 0) return null;
  if (!SESSION_UUID.test(sessionId) || !labelIsSession(host.slice(0, dot), sessionId)) return null;
  return host.slice(dot + 1).toLowerCase();
}

/**
 * Whether `url` may be opened with this session's one-time preview ticket.
 * The ticket is a credential, so it only ever goes where the Hub said this
 * session's preview lives:
 *  - the Hub's own origin, under this session's `/api/sessions/<id>/preview/proxy`;
 *  - this session's subdomain (`<id>.` or `<port>--<id>.`) under the same base
 *    domain and scheme as the preview URL the Hub reported.
 * Any other destination, typed or not, loads without a ticket. A direct
 * dev-server port never needs one.
 */
export function previewTicketAllowed(url: string, scope: PreviewTicketScope): boolean {
  const target = parseHttp(url);
  if (!target || !scope.sessionId) return false;
  const hub = parseHttp(scope.hubBase);
  if (hub && target.origin === hub.origin) {
    const prefix = `/api/sessions/${encodeURIComponent(scope.sessionId)}/preview/proxy`;
    const path = target.pathname;
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  const reported = scope.reportedUrl ? parseHttp(scope.reportedUrl) : null;
  if (!reported || reported.protocol !== target.protocol) return false;
  const base = sessionSubdomainBase(reported.hostname, scope.sessionId);
  return !!base && sessionSubdomainBase(target.hostname, scope.sessionId) === base;
}

export function withPreviewTicket(url: string, ticket: string): string {
  if (!url || !ticket) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('ticket', ticket);
    return u.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}ticket=${encodeURIComponent(ticket)}`;
  }
}

/** Cache-bust so a refresh after the agent edits fetches a new document. */
export function bustPreviewUrl(url: string, token: unknown): string {
  if (!url || token == null || token === '') return url;
  try {
    const u = new URL(url);
    u.searchParams.set('_ah', String(token));
    return u.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}_ah=${encodeURIComponent(String(token))}`;
  }
}
