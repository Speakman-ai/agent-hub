/**
 * routes/github-oauth.ts — "Sign in with GitHub" user-identity endpoints.
 *
 *   GET    /api/auth/github/start     — returns { authorizeUrl }; client redirects the browser
 *   GET    /api/auth/github/callback  — public; validates state, exchanges code, stores tokens, redirects back to the UI
 *   GET    /api/auth/github/status    — { connected, login, connectedAt, tokenExpiresAt }
 *   DELETE /api/auth/github           — disconnect the calling user's GitHub link
 *
 * CSRF / identity binding on callback:
 *   The callback lands via a cross-origin redirect from github.com, so
 *   the hub's bearer JWT is not sent. We instead mint a short-lived
 *   signed state token (`signJwt` with `purpose: 'github-oauth'`) at
 *   `/start` that carries the authenticated user's `uid`. On callback we
 *   verify the state, pull `uid`, and store tokens against that user.
 *   The state signature is what prevents an attacker from forging a
 *   callback that links their GitHub account to someone else's hub user.
 *
 * Config requirements:
 *   `config.githubApp.clientId` and `config.githubApp.clientSecret` must
 *   be set. These are the OAuth credentials on the GitHub App
 *   registration — already present in `GitHubAppConfig`. When missing,
 *   `/start` returns 503 so the UI can surface "GitHub sign-in not
 *   configured" instead of hanging the user on a broken redirect.
 */
import { Router, Request, Response } from 'express';
import type { RouteDeps, AppConfig } from '../types.js';
import { signJwt, verifyJwt } from '../jwt.js';
import { getAuthRecord } from '../auth-store.js';
import type { AuthenticatedRequest } from '../auth.js';
import { buildAuthorizeUrl, exchangeCodeForToken, fetchUserInfo } from '../github-oauth.js';
import {
  upsertGithubConnection,
  getGithubConnectionStatus,
  deleteGithubConnection,
} from '../github-connections-store.js';

const STATE_TOKEN_TTL_SEC = 10 * 60; // 10 min — plenty for the redirect round-trip
const STATE_PURPOSE = 'github-oauth';

interface GithubOAuthState {
  /** JWT `sub` — the authenticated hub user id when the state was minted. */
  sub: string;
  purpose: string;
  returnTo?: string;
}

function getOAuthCredentials(config: AppConfig): { clientId: string; clientSecret: string } | null {
  const app = config.githubApp;
  if (!app?.clientId || !app?.clientSecret) return null;
  return { clientId: app.clientId, clientSecret: app.clientSecret };
}

function getRedirectUri(config: AppConfig, req: Request): string {
  // Prefer the configured public URL (prod behind nginx) so that the
  // URI registered on the GitHub App matches. Fall back to the incoming
  // request's origin for local dev where publicUrl is null.
  const base =
    config.publicUrl?.replace(/\/+$/, '') ||
    `${req.protocol}://${req.get('host') || `localhost:${config.port}`}`;
  return `${base}/api/auth/github/callback`;
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

export default function createGithubOAuthRoutes(deps: RouteDeps): Router {
  const { config } = deps;
  const router = Router();

  // ── Start: mint state token + authorize URL ────────────────────
  router.get('/api/auth/github/start', (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
    const uid = areq.authUserId;
    if (!uid) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const creds = getOAuthCredentials(config);
    if (!creds) {
      return res.status(503).json({
        error: 'GitHub OAuth is not configured on this server',
        code: 'github_oauth_not_configured',
      });
    }
    const record = getAuthRecord();
    if (!record) {
      // Pre-setup — nobody can be authenticated anyway, but belt-and-suspenders.
      return res.status(503).json({ error: 'Auth not initialized' });
    }
    const returnToRaw = typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined;
    // Reject absolute URLs and protocol-relative URLs (//evil.com) to prevent open-redirect.
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
    });
    return res.json({ authorizeUrl });
  });

  // ── Callback: exchange code, persist tokens ────────────────────
  // Public path — GitHub redirects the user here with no auth header.
  // Identity is carried by the signed `state` JWT.
  router.get('/api/auth/github/callback', async (req: Request, res: Response) => {
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
            title: 'GitHub sign-in cancelled',
            message: `GitHub reported: ${errorParam}. You can close this tab and try again.`,
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
    const payload = verification.payload as unknown as GithubOAuthState;
    if (payload.purpose !== STATE_PURPOSE || typeof payload.sub !== 'string' || !payload.sub) {
      return res
        .status(400)
        .type('html')
        .send(
          renderCallbackPage({
            title: 'Invalid state token',
            message: 'The state parameter was not issued for GitHub sign-in.',
            isError: true,
          }),
        );
    }
    const callerUserId = payload.sub;

    const creds = getOAuthCredentials(config);
    if (!creds) {
      return res
        .status(503)
        .type('html')
        .send(
          renderCallbackPage({
            title: 'GitHub OAuth not configured',
            message: 'The server is missing GitHub App OAuth credentials.',
            isError: true,
          }),
        );
    }

    try {
      const tokens = await exchangeCodeForToken({
        credentials: creds,
        code,
        redirectUri: getRedirectUri(config, req),
      });
      const userInfo = await fetchUserInfo({ accessToken: tokens.access_token });
      const nowMs = Date.now();
      upsertGithubConnection({
        userId: callerUserId,
        login: userInfo.login,
        accessToken: tokens.access_token,
        tokenExpiresAt: new Date(nowMs + tokens.expires_in * 1000).toISOString(),
        refreshToken: tokens.refresh_token,
        refreshExpiresAt: new Date(nowMs + tokens.refresh_token_expires_in * 1000).toISOString(),
      });

      // Defense-in-depth: re-validate returnTo at render time even though
      // the /start route already filters it before signing the state JWT.
      const rawReturn = typeof payload.returnTo === 'string' ? payload.returnTo : '';
      const returnTo = rawReturn.startsWith('/') && !rawReturn.startsWith('//') ? rawReturn : '/';
      return res
        .status(200)
        .type('html')
        .send(
          renderCallbackPage({
            title: `Connected as @${userInfo.login}`,
            message: `Returning you to Agent Hub…`,
            redirectTo: returnTo,
            isError: false,
          }),
        );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[github-oauth] Callback failed: ${msg.split('\n')[0]}`);
      return res
        .status(502)
        .type('html')
        .send(
          renderCallbackPage({
            title: 'GitHub sign-in failed',
            message: msg.split('\n')[0],
            isError: true,
          }),
        );
    }
  });

  // ── Status: for the Settings UI to render "Connected as @foo" ─
  router.get('/api/auth/github/status', (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
    const uid = areq.authUserId;
    if (!uid) return res.status(401).json({ error: 'Not authenticated' });
    const status = getGithubConnectionStatus(uid);
    const creds = getOAuthCredentials(config);
    return res.json({
      ...status,
      serverConfigured: !!creds,
    });
  });

  // ── Disconnect ──────────────────────────────────────────────────
  router.delete('/api/auth/github', (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
    const uid = areq.authUserId;
    if (!uid) return res.status(401).json({ error: 'Not authenticated' });
    deleteGithubConnection(uid);
    return res.json({ ok: true });
  });

  return router;
}
