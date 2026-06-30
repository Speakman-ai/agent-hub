/**
 * routes/google-oauth.ts — "Connect Google" user-identity endpoints.
 *
 *   GET /api/auth/google/start — returns { authorizeUrl }; client redirects the browser.
 *
 * This route is the entry point of the per-user Google OAuth flow. The callback,
 * the encrypted per-user connection store, status, and disconnect are owned by
 * the connection-management ticket (AH-1266/1267); this file currently provides
 * `/start` so the connect UI has a working seam and degrades gracefully when the
 * server-global OAuth app is not configured.
 *
 * Config requirement:
 *   `config.googleOAuth.{clientId,clientSecret}` must be set (Admin/Owner config
 *   this in-app via `/api/config/google-oauth`). When missing, `/start` returns
 *   503 `google_oauth_not_configured` so the UI can surface "Google not
 *   configured" instead of hanging the user on a broken redirect.
 *
 * CSRF / identity binding:
 *   The eventual callback lands via a cross-origin redirect from Google, so the
 *   hub's bearer JWT is not sent. We mint a short-lived signed state token
 *   (`signJwt` with `purpose: 'google-oauth'`) carrying the authenticated
 *   user's id; the callback (separate ticket) verifies it before linking.
 */
import { Router, Request, Response } from 'express';
import type { RouteDeps, AppConfig } from '../types.js';
import { signJwt } from '../jwt.js';
import { getAuthRecord } from '../auth-store.js';
import { resolveOAuthConnectionUserId } from '../github-connection-user.js';
import { buildAuthorizeUrl, resolveGoogleRedirectUri } from '../google-oauth.js';
import { registerPath, z } from '../openapi/registry.js';

const STATE_TOKEN_TTL_SEC = 10 * 60; // 10 min — plenty for the redirect round-trip
const STATE_PURPOSE = 'google-oauth';

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

    const returnToRaw = typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined;
    // Reject absolute and protocol-relative URLs (//evil.com) to block open-redirect.
    const returnTo =
      returnToRaw && returnToRaw.startsWith('/') && !returnToRaw.startsWith('//')
        ? returnToRaw
        : undefined;

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

  return router;
}
