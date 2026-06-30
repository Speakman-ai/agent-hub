/**
 * routes/google-oauth.ts — "Connect Google" user-identity endpoints.
 *
 *   GET    /api/auth/google/start    — returns { authorizeUrl }; client redirects the browser.
 *   GET    /api/auth/google/callback — public; verifies state, exchanges code, stores the
 *                                      encrypted per-user connection, redirects back to the UI.
 *   GET    /api/auth/google/status   — { connected, email, grantedScopes, … } (never tokens).
 *   DELETE /api/auth/google/connect  — best-effort revoke at Google, then clear the row.
 *
 * The connection is per-USER (mirrors GitHub), surfaced in Account settings. Tokens
 * are encrypted at rest by `google-connections-store.ts`; this file never returns them.
 *
 * Config requirement:
 *   `config.googleOAuth.{clientId,clientSecret}` must be set (Admin/Owner config
 *   this in-app via `/api/config/google-oauth`). When missing, `/start` returns
 *   503 `google_oauth_not_configured` so the UI can surface "Google not
 *   configured" instead of hanging the user on a broken redirect.
 *
 * CSRF / identity binding:
 *   The callback lands via a cross-origin redirect from Google, so the hub's
 *   bearer JWT is not sent. We mint a short-lived signed state token (`signJwt`
 *   with `purpose: 'google-oauth'`) at `/start` carrying the authenticated
 *   user's id; the callback verifies the state signature, pulls `sub`, and
 *   links the Google account to that user. The signature is what prevents an
 *   attacker from forging a callback that links their Google account to
 *   someone else's hub user.
 */
import { Router, Request, Response } from 'express';
import type { RouteDeps, AppConfig } from '../types.js';
import { signJwt, verifyJwt } from '../jwt.js';
import { getAuthRecord } from '../auth-store.js';
import { resolveOAuthConnectionUserId } from '../github-connection-user.js';
import {
  buildAuthorizeUrl,
  resolveGoogleRedirectUri,
  exchangeCodeForGoogleTokens,
  fetchGoogleUserInfo,
  revokeGoogleToken,
} from '../google-oauth.js';
import {
  upsertGoogleConnection,
  getGoogleConnection,
  getGoogleConnectionStatus,
  deleteGoogleConnection,
} from '../google-connections-store.js';
import { registerPath, z } from '../openapi/registry.js';

registerPath({
  method: 'get',
  path: '/api/auth/google/callback',
  tags: ['Auth'],
  summary: 'Google OAuth callback — exchanges code for tokens (HTML response).',
  request: {
    query: z.object({
      code: z.string().optional(),
      state: z.string().optional(),
      error: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Successful connect (HTML status page).',
      content: { 'text/html': { schema: z.string() } },
    },
    400: {
      description: 'Missing or invalid parameters / state.',
      content: { 'text/html': { schema: z.string() } },
    },
    502: {
      description: 'Google token exchange failed.',
      content: { 'text/html': { schema: z.string() } },
    },
    503: {
      description: 'Server not ready or OAuth not configured.',
      content: { 'text/html': { schema: z.string() } },
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/auth/google/status',
  tags: ['Auth'],
  summary: 'Google connection status for the calling user (never returns tokens).',
  responses: {
    200: {
      description: 'Connection summary.',
      content: {
        'application/json': {
          schema: z.object({
            connected: z.boolean(),
            email: z.string().nullable(),
            grantedScopes: z.array(z.string()),
            connectedAt: z.string().nullable(),
            tokenExpiresAt: z.string().nullable(),
            serverConfigured: z.boolean(),
          }),
        },
      },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: z.object({ error: z.string() }) } },
    },
  },
});

registerPath({
  method: 'delete',
  path: '/api/auth/google/connect',
  tags: ['Auth'],
  summary: 'Disconnect the calling user from Google (revoke + clear).',
  responses: {
    200: {
      description: 'Disconnected.',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: z.object({ error: z.string() }) } },
    },
  },
});

const STATE_TOKEN_TTL_SEC = 10 * 60; // 10 min — plenty for the redirect round-trip
const STATE_PURPOSE = 'google-oauth';

interface GoogleOAuthState {
  /** JWT `sub` — the authenticated hub user id when the state was minted. */
  sub: string;
  purpose: string;
  returnTo?: string;
}

/** Replace HTML-special characters with their entity equivalents. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCallbackPage(opts: {
  title: string;
  message: string;
  redirectTo?: string;
  isError: boolean;
}): string {
  const safeTitle = escapeHtml(opts.title);
  const safeMessage = escapeHtml(opts.message);
  const safeRedirect = opts.redirectTo ? escapeHtml(opts.redirectTo) : '';
  const redirectMeta = safeRedirect
    ? `<meta http-equiv="refresh" content="2;url=${safeRedirect}">`
    : '';
  const color = opts.isError ? '#ef4444' : '#10b981';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${redirectMeta}
<title>${safeTitle}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: #0b0f17; color: #e5e7eb; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { max-width: 420px; text-align: center; padding: 32px; background: #111827; border: 1px solid #1f2937; border-radius: 12px; }
  h1 { margin: 0 0 8px; font-size: 18px; color: ${color}; }
  p { margin: 0; color: #9ca3af; font-size: 14px; line-height: 1.6; }
</style>
</head>
<body>
<div class="card">
<h1>${safeTitle}</h1>
<p>${safeMessage}</p>
</div>
</body>
</html>`;
}

/** Parse the space-delimited `scope` string from a token response into a list. */
function parseGrantedScopes(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Validate a caller-supplied `returnTo` as a same-origin site-relative path,
 * returning `undefined` for anything that could escape the origin. Open-redirect
 * defense for both `/start` (before signing it into the state JWT) and the
 * callback (before emitting it in the meta-refresh).
 *
 * Rejects:
 *   - non-strings / empty
 *   - absolute URLs (`https://evil.com`) — they don't start with `/`
 *   - protocol-relative URLs (`//evil.com`)
 *   - backslash variants (`/\evil.com`, `\/evil.com`) — browsers normalize `\`
 *     to `/`, so these resolve to a protocol-relative external redirect, and
 *     `escapeHtml` does not neutralize `\`.
 */
function sanitizeReturnToPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  if (!raw.startsWith('/')) return undefined;
  if (raw.startsWith('//')) return undefined;
  if (raw.includes('\\')) return undefined;
  return raw;
}

registerPath({
  method: 'get',
  path: '/api/auth/google/start',
  tags: ['Auth'],
  summary: 'Mint a signed state token + return the Google authorize URL.',
  request: {
    query: z.object({
      returnTo: z.string().optional(),
      scopes: z.string().optional().openapi({
        description:
          'Optional space- or comma-separated extra OAuth scopes for incremental per-surface consent. Identity scopes (openid email profile) are always included.',
      }),
    }),
  },
  responses: {
    200: {
      description: 'Authorize URL the client should redirect the browser to.',
      content: { 'application/json': { schema: z.object({ authorizeUrl: z.string() }) } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: z.object({ error: z.string() }) } },
    },
    503: {
      description: 'Google OAuth not configured on the server.',
      content: {
        'application/json': { schema: z.object({ error: z.string(), code: z.string() }) },
      },
    },
  },
});

function getRedirectUri(config: AppConfig, req: Request): string {
  // Reuse the shared resolver so /start and GET /config/google-oauth (which the
  // admin UI displays) always agree on the canonical redirect URI. Prefer the
  // configured public URL (prod behind nginx, may carry a path prefix), falling
  // back to the request origin for local dev where publicUrl is null.
  return resolveGoogleRedirectUri({
    publicUrl: config.publicUrl,
    requestOrigin: `${req.protocol}://${req.get('host') || `localhost:${config.port}`}`,
  });
}

/** Parse the optional `scopes` query (space- or comma-separated) into a list. */
function parseScopesParam(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function createGoogleOAuthRoutes(deps: RouteDeps): Router {
  const { config } = deps;
  const router = Router();

  router.get('/api/auth/google/start', (req: Request, res: Response) => {
    // Config-state check first: it is server-global (same info the Admin GET
    // exposes) and the "degrade gracefully" contract wants this 503 regardless
    // of the caller's auth state.
    const creds = config.googleOAuth;
    if (!creds?.clientId || !creds?.clientSecret) {
      return res.status(503).json({
        error: 'Google OAuth is not configured on this server',
        code: 'google_oauth_not_configured',
      });
    }

    const uid = resolveOAuthConnectionUserId(req);
    if (!uid) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const record = getAuthRecord();
    if (!record) {
      return res.status(503).json({
        error: 'Auth not initialized',
        code: 'auth_not_initialized',
      });
    }

    // Reject absolute, protocol-relative, and backslash-escaped URLs to block
    // open-redirect before this value is signed into the state JWT.
    const returnTo = sanitizeReturnToPath(req.query.returnTo);

    const stateToken = signJwt(uid, record.jwtSecret, {
      expiresInSec: STATE_TOKEN_TTL_SEC,
      claims: { purpose: STATE_PURPOSE, ...(returnTo && { returnTo }) },
    });

    const authorizeUrl = buildAuthorizeUrl({
      clientId: creds.clientId,
      redirectUri: getRedirectUri(config, req),
      state: stateToken,
      scopes: parseScopesParam(req.query.scopes),
    });

    return res.json({ authorizeUrl });
  });

  // ── Callback: verify state, exchange code, persist encrypted tokens ──
  // Public path — Google redirects the user here with no auth header.
  // Identity is carried by the signed `state` JWT minted at /start.
  router.get('/api/auth/google/callback', async (req: Request, res: Response) => {
    // Restrictive CSP: this page is a static status card with inline styles —
    // no scripts, images, or external resources should ever load.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const errorParam = typeof req.query.error === 'string' ? req.query.error : '';

    if (errorParam) {
      return res
        .status(400)
        .type('html')
        .send(
          renderCallbackPage({
            title: 'Google connection cancelled',
            message: `Google reported: ${errorParam}. You can close this tab and try again.`,
            isError: true,
          }),
        );
    }
    if (!code || !state) {
      return res
        .status(400)
        .type('html')
        .send(
          renderCallbackPage({
            title: 'Missing parameters',
            message: 'The callback URL was missing `code` or `state`.',
            isError: true,
          }),
        );
    }

    const record = getAuthRecord();
    if (!record) {
      return res
        .status(503)
        .type('html')
        .send(
          renderCallbackPage({
            title: 'Server not ready',
            message: 'Auth is not configured on this server.',
            isError: true,
          }),
        );
    }

    const verification = verifyJwt(state, record.jwtSecret);
    if (!verification.ok || !verification.payload) {
      return res
        .status(400)
        .type('html')
        .send(
          renderCallbackPage({
            title: 'Invalid state token',
            message: `The state parameter could not be verified (${verification.reason}). This can happen if the sign-in took too long. Please try again.`,
            isError: true,
          }),
        );
    }
    const payload = verification.payload as unknown as GoogleOAuthState;
    if (payload.purpose !== STATE_PURPOSE || typeof payload.sub !== 'string' || !payload.sub) {
      return res
        .status(400)
        .type('html')
        .send(
          renderCallbackPage({
            title: 'Invalid state token',
            message: 'The state parameter was not issued for Google sign-in.',
            isError: true,
          }),
        );
    }
    const callerUserId = payload.sub;

    const creds = config.googleOAuth;
    if (!creds?.clientId || !creds?.clientSecret) {
      return res
        .status(503)
        .type('html')
        .send(
          renderCallbackPage({
            title: 'Google OAuth not configured',
            message: 'The server is missing Google OAuth client credentials.',
            isError: true,
          }),
        );
    }

    try {
      const tokens = await exchangeCodeForGoogleTokens({
        credentials: creds,
        code,
        redirectUri: getRedirectUri(config, req),
      });
      const userInfo = await fetchGoogleUserInfo({ accessToken: tokens.access_token });
      const nowMs = Date.now();
      const tokenExpiresAt = new Date(nowMs + tokens.expires_in * 1000).toISOString();
      // Google omits refresh_token on an incremental re-consent that adds no
      // new scopes. prompt=consent usually re-issues one, but preserve the
      // existing refresh token if this response lacks one so a re-consent
      // never strands the connection without a refresh path.
      const refreshToken =
        tokens.refresh_token || getGoogleConnection(callerUserId)?.refreshToken || null;
      upsertGoogleConnection({
        userId: callerUserId,
        googleSub: userInfo.sub,
        googleEmail: userInfo.email,
        accessToken: tokens.access_token,
        tokenExpiresAt,
        refreshToken,
        grantedScopes: parseGrantedScopes(tokens.scope),
      });

      // Defense-in-depth: re-validate at render time even though /start already
      // filtered returnTo before signing it into the state JWT. Coerce anything
      // unsafe to the app root so the meta-refresh can never redirect off-site.
      const returnTo = sanitizeReturnToPath(payload.returnTo) ?? '/';
      return res
        .status(200)
        .type('html')
        .send(
          renderCallbackPage({
            title: userInfo.email ? `Connected as ${userInfo.email}` : 'Google connected',
            message: 'Returning you to Agent Hub…',
            redirectTo: returnTo,
            isError: false,
          }),
        );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[google-oauth] Callback failed: ${msg.split('\n')[0]}`);
      return res
        .status(502)
        .type('html')
        .send(
          renderCallbackPage({
            title: 'Google connection failed',
            message: msg.split('\n')[0],
            isError: true,
          }),
        );
    }
  });

  // ── Status: for the Account settings UI. Never returns tokens. ──
  router.get('/api/auth/google/status', (req: Request, res: Response) => {
    const uid = resolveOAuthConnectionUserId(req);
    if (!uid) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const status = getGoogleConnectionStatus(uid);
    const creds = config.googleOAuth;
    return res.json({
      ...status,
      serverConfigured: !!(creds?.clientId && creds?.clientSecret),
    });
  });

  // ── Disconnect: best-effort revoke at Google, then clear the row ──
  router.delete('/api/auth/google/connect', async (req: Request, res: Response) => {
    const uid = resolveOAuthConnectionUserId(req);
    if (!uid) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    // Best-effort revoke so the grant is dropped on Google's side too. Revoking
    // the refresh token cascades to its access tokens. revokeGoogleToken never
    // throws — a failed revoke must not block clearing the local connection.
    const conn = getGoogleConnection(uid);
    const tokenToRevoke = conn?.refreshToken || conn?.accessToken;
    if (tokenToRevoke) {
      await revokeGoogleToken({ token: tokenToRevoke });
    }
    deleteGoogleConnection(uid);
    return res.json({ ok: true });
  });

  return router;
}
