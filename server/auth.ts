import type { IncomingMessage } from 'http';
import type { Request, Response, NextFunction } from 'express';
import config from './config.js';
import { verifyJwt } from './jwt.js';
import { getAuthRecord } from './auth-store.js';
import type { Role } from './roles.js';

/**
 * Endpoints the auth middleware always lets through. Anything that is
 * needed BEFORE a client can authenticate (health, login) must be on
 * this list — everything else is gated by either a valid JWT or a valid
 * `X-API-Key`. Note: `/api/auth/setup` is handled separately below — it
 * is public only when no auth mechanism (neither apiKey nor JWT) is
 * configured.
 */
const PUBLIC_PATHS: readonly string[] = [
  '/api/health',
  '/api/github-app/callback',
  '/api/github-app/setup-complete',
  '/api/github-app/register',
  '/api/bug-reports',
  // ── Auth bootstrap endpoints ─────────────────────────────────
  '/api/auth/status',
  '/api/auth/login',
];

/** Augmented Express request populated by the middleware on success. */
export interface AuthenticatedRequest extends Request {
  /** Subject (username) when the caller used a JWT. */
  authUser?: string;
  /** True when the caller used the apiKey fallback. */
  authViaApiKey?: boolean;
  /**
   * Resolved role for the authenticated caller (Phase 2). Populated from
   * the user record on successful JWT verification, or forced to 'Owner'
   * when the apiKey path is taken — the apiKey is the break-glass shared
   * secret and is treated as full privilege for backward compatibility.
   */
  authRole?: Role;
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  // Intentionally NOT falling back to `?token=` on REST: query strings end
  // up in Nginx access logs, `Referer` headers, and browser history. The
  // WebSocket handshake uses `?token=` (browsers can't set headers on a
  // `new WebSocket(...)` call) — that's handled separately in
  // `authenticateWsDetailed`.
  return null;
}

function extractApiKey(req: Request): string | null {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.length > 0) return header;
  const query = req.query.apiKey;
  if (typeof query === 'string' && query.length > 0) return query;
  return null;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiKey = config.apiKey;
  const authRecord = getAuthRecord();

  // No auth configured at all → let everything through (dev / fresh install).
  if (!apiKey && !authRecord) {
    next();
    return;
  }

  // Only gate /api/* — static assets / SPA HTML are always served.
  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }

  if (PUBLIC_PATHS.includes(req.path)) {
    next();
    return;
  }

  // `/api/auth/setup` is public only when no auth is protecting the server
  // yet (neither apiKey nor JWT). If an apiKey is configured but JWT hasn't
  // been set up, the caller must prove they hold the apiKey — otherwise an
  // unauthenticated attacker could claim the JWT identity before the real
  // owner does.
  if (req.path === '/api/auth/setup' && !authRecord) {
    if (!apiKey) {
      next();
      return;
    }
    // apiKey is set → fall through to the normal apiKey check below.
  }

  const authedReq = req as AuthenticatedRequest;

  // ── Try JWT first (takes precedence over apiKey) ───────────────
  if (authRecord) {
    const token = extractBearerToken(req);
    if (token) {
      const verified = verifyJwt(token, authRecord.jwtSecret);
      if (verified.ok) {
        authedReq.authUser = verified.payload!.sub;
        // Phase 1 is single-user, so the token's sub always maps to the
        // stored record. When Phase 3 introduces multi-user we'll swap
        // this lookup for a real users table; the middleware contract
        // (req.authRole is a Role or undefined) stays the same.
        authedReq.authRole = authRecord.role;
        next();
        return;
      }
      // Token was present but invalid — fall through so we can still try
      // apiKey. This lets clients mix mechanisms during migration (e.g.
      // a CLI script with an apiKey hitting a JWT-enabled server).
    }
  }

  // ── Then fall back to the legacy X-API-Key ─────────────────────
  if (apiKey) {
    const provided = extractApiKey(req);
    if (provided && provided === apiKey) {
      authedReq.authViaApiKey = true;
      // The apiKey is the break-glass shared secret; treat it as full
      // privilege so existing CLI scripts keep working after Phase 2.
      authedReq.authRole = 'Owner';
      next();
      return;
    }
    if (provided) {
      res.status(403).json({ error: 'Invalid API key.' });
      return;
    }
  }

  // Nothing valid was provided. Prefer the JWT-style error message when
  // JWT auth is configured — it's the primary mechanism.
  if (authRecord) {
    res.status(401).json({
      error: 'Authentication required. Provide a bearer token via Authorization header.',
    });
    return;
  }
  res.status(401).json({
    error: 'API key required. Set X-API-Key header or ?apiKey= query param.',
  });
}

export interface WsAuthResult {
  ok: boolean;
  subject?: string;
  viaApiKey?: boolean;
}

/**
 * WebSocket authentication. Accepts either:
 *   - `?token=<jwt>` — Bearer-equivalent for WS (the browser can't set
 *     custom headers on a `new WebSocket(...)` handshake).
 *   - `?apiKey=<key>` — legacy API-key mechanism.
 *
 * Returns a structured result so callers can attach the identity to the
 * connection if they want — the existing call site just checks `.ok`.
 */
export function authenticateWsDetailed(request: IncomingMessage): WsAuthResult {
  const apiKey = config.apiKey;
  const authRecord = getAuthRecord();
  if (!apiKey && !authRecord) return { ok: true };

  const url = new URL(request.url!, `http://${request.headers.host}`);
  if (authRecord) {
    const token = url.searchParams.get('token');
    if (token) {
      const verified = verifyJwt(token, authRecord.jwtSecret);
      if (verified.ok) return { ok: true, subject: verified.payload!.sub };
    }
  }
  if (apiKey) {
    const provided = url.searchParams.get('apiKey');
    if (provided && provided === apiKey) return { ok: true, viaApiKey: true };
  }
  return { ok: false };
}

/** Back-compat boolean wrapper used by the existing WebSocket setup. */
export function authenticateWs(request: IncomingMessage): boolean {
  return authenticateWsDetailed(request).ok;
}
