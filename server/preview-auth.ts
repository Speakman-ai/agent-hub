/**
 * Iframe-safe auth for the session preview proxy.
 *
 * Why this exists
 * ───────────────
 * The session preview lives at
 *
 *   /api/sessions/:sessionId/preview/proxy/...
 *
 * which is rendered by the SPA inside an `<iframe>`. A browser cannot
 * attach `Authorization: Bearer …` headers to an iframe top-level
 * navigation — that's a hard limit of the platform (the same reason the
 * WebSocket handshake uses `?token=`, since `new WebSocket(...)` can't
 * set headers either). Only cookies ride along on a top-level nav, and
 * the SPA stores its JWT in `localStorage`, not in a cookie, so the
 * iframe load lands at the auth middleware with no credential at all
 * and the server replies with 401.
 *
 * Electron and the local dev iframe (which points straight at
 * `http://localhost:<port>`) don't see this — Electron's main process
 * injects the header via `webRequest`, and local dev bypasses the Hub
 * proxy entirely. The 401 is a pure-browser-on-remote bug.
 *
 * Mechanism
 * ─────────
 *  1. SPA calls `POST /api/sessions/:id/preview/ticket` with its JWT.
 *     The server mints a single-use ticket bound to `(sessionId,
 *     userId, role, orgId)` with ~60 s TTL.
 *
 *  2. SPA puts `?ticket=<ticket>` on the iframe's `src`. The browser
 *     navigates to it. The auth middleware sees the query param, looks
 *     it up here, marks it consumed, mints a server-side cookie token,
 *     and writes a path-scoped HttpOnly cookie back on the same
 *     response.
 *
 *  3. Sub-resources fetched by the iframe (`.js`, `.css`, images, etc.)
 *     carry the path-scoped cookie because they share the same origin
 *     and path prefix. The middleware accepts the cookie as an
 *     alternative to Bearer / X-API-Key for `/preview/proxy/*` only.
 *
 * Safety properties
 * ─────────────────
 *  - **Tickets are single-use and short-lived.** A replay or stolen URL
 *    is at worst a single proxy hop within the 60 s window.
 *  - **Cookies are path-scoped to `/api/sessions/<sid>/preview/proxy/`.**
 *    They cannot escape to other Hub routes; the browser will not send
 *    them outside that prefix.
 *  - **HttpOnly + SameSite=Strict + Secure (in prod).** No JS access,
 *    no cross-site send, no plaintext leak.
 *  - **Server-side store.** The cookie value is an opaque random token;
 *    revocation is a single map delete. Tokens expire on a wall-clock
 *    basis and the maps are swept lazily on every read.
 */

import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import type { Role } from './roles.js';

/**
 * Authentication context that the preview proxy must reconstruct from
 * either a ticket or a cookie before allowing the request through.
 * Mirrors the subset of `AuthenticatedRequest` fields downstream code
 * (`userOwnsSession`, `requireRole`) actually reads.
 */
export interface PreviewAuthContext {
  /** Resolved user id (from JWT `uid` claim or per-user API key). */
  userId: string | null;
  /** Subject / username — used only for `authUser`. */
  username: string | null;
  /** Resolved role for the caller (`'User'` minimum). */
  role: Role;
  /** Active org id at the time the ticket was minted. */
  orgId: string | null;
}

interface TicketRecord {
  sessionId: string;
  ctx: PreviewAuthContext;
  expiresAt: number;
  consumed: boolean;
}

interface CookieRecord {
  sessionId: string;
  ctx: PreviewAuthContext;
  expiresAt: number;
}

/** Tickets are short-lived and single-use; default TTL 60 s. */
export const PREVIEW_TICKET_TTL_MS = 60_000;

/**
 * Cookies live longer than tickets — they cover the full
 * lifetime of the iframe's sub-resource fetches. Default 5 min. The
 * browser also enforces this via `Max-Age` on the Set-Cookie.
 */
export const PREVIEW_COOKIE_TTL_MS = 5 * 60_000;

/** Length of the random portion of a ticket / cookie token (bytes). */
const TOKEN_BYTES = 24;

const ticketStore = new Map<string, TicketRecord>();
const cookieStore = new Map<string, CookieRecord>();

function now(): number {
  return Date.now();
}

function sweepExpired(): void {
  const t = now();
  for (const [k, v] of ticketStore) {
    if (v.expiresAt <= t || v.consumed) ticketStore.delete(k);
  }
  for (const [k, v] of cookieStore) {
    if (v.expiresAt <= t) cookieStore.delete(k);
  }
}

/**
 * Mint a fresh single-use ticket bound to `(sessionId, ctx)`. The
 * returned string is opaque to callers — the only contract is that
 * passing it to `consumePreviewTicket(ticket, sessionId)` within
 * `PREVIEW_TICKET_TTL_MS` returns the original context.
 */
export function mintPreviewTicket(sessionId: string, ctx: PreviewAuthContext): string {
  sweepExpired();
  const ticket = `ahpt_${randomBytes(TOKEN_BYTES).toString('hex')}`;
  ticketStore.set(ticket, {
    sessionId,
    ctx,
    expiresAt: now() + PREVIEW_TICKET_TTL_MS,
    consumed: false,
  });
  return ticket;
}

/**
 * Single-use lookup. Returns the bound `PreviewAuthContext` on the
 * first call within the TTL window and `null` for every subsequent
 * call, an expired ticket, an unknown ticket, or a `sessionId`
 * mismatch. The latter is critical: a ticket minted for session A must
 * never authenticate a request for session B.
 */
export function consumePreviewTicket(
  ticket: string | undefined | null,
  sessionId: string,
): PreviewAuthContext | null {
  if (!ticket) return null;
  const record = ticketStore.get(ticket);
  if (!record) return null;
  if (record.consumed) {
    // Defensive: a consumed record should already be deleted, but if
    // sweepExpired() hasn't fired yet we still reject.
    return null;
  }
  if (record.expiresAt <= now()) {
    ticketStore.delete(ticket);
    return null;
  }
  if (record.sessionId !== sessionId) {
    return null;
  }
  record.consumed = true;
  ticketStore.delete(ticket);
  return record.ctx;
}

/**
 * Issue a server-side cookie token after a ticket has been consumed.
 * The returned string is the value that goes into the `Set-Cookie`
 * header; `consumePreviewCookie` is what the auth middleware calls on
 * subsequent requests carrying that cookie.
 */
export function issuePreviewCookieToken(sessionId: string, ctx: PreviewAuthContext): string {
  sweepExpired();
  const token = `ahpc_${randomBytes(TOKEN_BYTES).toString('hex')}`;
  cookieStore.set(token, {
    sessionId,
    ctx,
    expiresAt: now() + PREVIEW_COOKIE_TTL_MS,
  });
  return token;
}

/**
 * Lookup for the cookie auth path. Unlike tickets, cookies are not
 * single-use — they cover the full burst of sub-resource fetches the
 * iframe makes after the top-level nav. Expired entries are dropped on
 * read; `sessionId` is enforced.
 */
export function consumePreviewCookie(
  token: string | undefined | null,
  sessionId: string,
): PreviewAuthContext | null {
  if (!token) return null;
  const record = cookieStore.get(token);
  if (!record) return null;
  if (record.expiresAt <= now()) {
    cookieStore.delete(token);
    return null;
  }
  if (record.sessionId !== sessionId) {
    return null;
  }
  return record.ctx;
}

/** Test-only: drop every record in both stores. Never call from prod. */
export function resetPreviewAuthStoresForTest(): void {
  ticketStore.clear();
  cookieStore.clear();
}

/** Test-only: how many live records are in each store. */
export function previewAuthStoreSizesForTest(): { tickets: number; cookies: number } {
  return { tickets: ticketStore.size, cookies: cookieStore.size };
}

// ─── Path / header helpers (pure, exported for the auth middleware) ──

/**
 * Match a request path against the preview proxy mount. Returns the
 * URL-decoded `sessionId` on a hit and `null` otherwise. Used by the
 * auth middleware to decide whether to invoke the ticket/cookie path
 * at all; non-matching paths fall through unchanged.
 */
const PREVIEW_PROXY_PATH_RE = /^\/api\/sessions\/([^/]+)\/preview\/proxy(?:\/|$)/;
export function matchPreviewProxyPath(pathname: string | undefined | null): string | null {
  if (!pathname) return null;
  const m = pathname.match(PREVIEW_PROXY_PATH_RE);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/**
 * True for PWA manifest files served through the preview proxy mount.
 *
 * The App Manifest spec deliberately fetches manifests **without**
 * credentials (unlike `<script>` / `<link rel="stylesheet">`), so the
 * path-scoped preview HttpOnly cookie is never attached. Browsers then
 * hit the proxy unauthenticated and get 401 even when the rest of the
 * preview iframe works. Manifest JSON is non-secret; gating it on the
 * preview cookie buys nothing.
 */
export function isPreviewManifestAssetPath(pathname: string | undefined | null): boolean {
  if (!pathname || !matchPreviewProxyPath(pathname)) return false;
  return /\.webmanifest$/i.test(pathname);
}

/**
 * Cookie name for a given session. Namespacing by session id ensures
 * two preview cookies (different sessions) can coexist on the same
 * origin without one overwriting the other.
 *
 * Session ids are UUIDs in production but the helper sanitises
 * defensively because the cookie name set must obey RFC 6265 (no
 * control chars, no separators). Anything outside `[A-Za-z0-9-]` is
 * dropped.
 */
export function previewCookieName(sessionId: string): string {
  const safe = String(sessionId).replace(/[^A-Za-z0-9-]/g, '');
  return `ah_preview_${safe}`;
}

/**
 * Parse a `Cookie:` header into a key→value map. Standalone so the
 * server doesn't need to take a dependency on `cookie-parser` for this
 * one path; the auth middleware calls it inline.
 */
export function parseCookieHeader(header: string | undefined | null): Record<string, string> {
  if (!header || typeof header !== 'string') return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Build the `Set-Cookie` header value for a freshly-issued preview
 * cookie. `secure` should reflect the request — `true` behind TLS
 * (nginx/ALB sets `X-Forwarded-Proto: https`, Express resolves
 * `req.secure` with `trust proxy` set), `false` for plain `http://`
 * dev so the browser actually stores the cookie.
 */
export function buildPreviewSetCookie(
  sessionId: string,
  token: string,
  options: { secure: boolean; maxAgeMs?: number } = { secure: false },
): string {
  const name = previewCookieName(sessionId);
  const maxAgeSec = Math.floor((options.maxAgeMs ?? PREVIEW_COOKIE_TTL_MS) / 1000);
  // Path scoping is the load-bearing safety property here — the cookie
  // is invisible to every Hub route outside the proxy mount, so even a
  // compromised JS context on a different page cannot trigger an
  // authenticated fetch against the preview proxy on the cookie's
  // strength alone.
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/preview/proxy/`;
  const parts = [
    `${name}=${encodeURIComponent(token)}`,
    `Path=${path}`,
    `Max-Age=${maxAgeSec}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Pull the request's preview cookie value, if any. Returns `null` when
 * there is no `Cookie:` header, no matching key, or the value is
 * empty.
 */
export function readPreviewCookie(req: Request, sessionId: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length === 0) return null;
  const cookies = parseCookieHeader(header);
  const v = cookies[previewCookieName(sessionId)];
  return v && v.length > 0 ? v : null;
}
