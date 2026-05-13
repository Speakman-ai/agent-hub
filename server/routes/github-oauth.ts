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
import { createUser, getUserByUsername } from '../users-store.js';
import { resolveOAuthAppCredentials } from '../spawn-github-credentials.js';

const STATE_TOKEN_TTL_SEC = 10 * 60; // 10 min — plenty for the redirect round-trip
const STATE_PURPOSE = 'github-oauth';

interface GithubOAuthState {
  /** JWT `sub` — the authenticated hub user id when the state was minted. */
  sub: string;
  purpose: string;
  returnTo?: string;
}

/**
 * Local alias for the canonical OAuth-credentials resolver. Lives in
 * `spawn-github-credentials.ts` so the spawn-time `chat.ts` path and
 * these route handlers stay in lockstep on which OAuth App is used to
 * exchange codes / refresh tokens. See that module for precedence.
 */
function getOAuthCredentials(config: AppConfig): { clientId: string; clientSecret: string } | null {
  return resolveOAuthAppCredentials(config);
}

/**
 * Resolve the hub user id that owns the GitHub connection for this
 * request. Three paths:
 *
 *   1. JWT-authenticated request → `authUserId` is the resolved user row id.
 *   2. Local-mode org bypass → `authUserId` is unset because the auth
 *      middleware short-circuits without resolving a user row, but the
 *      install IS effectively single-tenant. Lazily get-or-create a
 *      deterministic synthetic user (`local-<orgId>`) so the GitHub
 *      connection has a stable anchor in the `users` table. Without
 *      this, "Sign in with GitHub" returned a confusing 401 in every
 *      Electron / desktop install.
 *   3. apiKey-only request → return `null`. The apiKey is a shared
 *      break-glass secret across machines and sub-agents; binding a
 *      personal GitHub identity to it would attribute "merge as user"
 *      actions to whoever held the secret, not the human at the
 *      keyboard. Personal GitHub sign-in requires real auth.
 */
function resolveOAuthUserId(req: Request): string | null {
  const areq = req as AuthenticatedRequest;
  if (areq.authUserId) return areq.authUserId;
  if (areq.authLocalOrgBypass && areq.authOrgId) {
    const username = `local-${areq.authOrgId}`;
    const existing = getUserByUsername(username);
    if (existing) return existing.id;
    // password_hash is NOT NULL in the schema; an empty string is fine
    // here — this synthetic row has no login path. Auth for local-mode
    // installs is gated by the org's `mode='local'` bypass, not by a
    // password check against this row.
    const created = createUser({ username, passwordHash: '' });
    return created.id;
  }
  return null;
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
    const uid = resolveOAuthUserId(req);
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
      // `expires_in` / `refresh_token` are optional in the OAuth response —
      // see `GitHubTokenResponse` for why. Persist nulls when missing so the
      // store knows this connection has no refresh path (classic OAuth Apps
      // and GitHub Apps without "Expire user authorization tokens" enabled).
      const tokenExpiresAt =
        typeof tokens.expires_in === 'number' && tokens.expires_in > 0
          ? new Date(nowMs + tokens.expires_in * 1000).toISOString()
          : null;
      const refreshToken = tokens.refresh_token || null;
      const refreshExpiresAt =
        refreshToken && typeof tokens.refresh_token_expires_in === 'number'
          ? new Date(nowMs + tokens.refresh_token_expires_in * 1000).toISOString()
          : null;
      upsertGithubConnection({
        userId: callerUserId,
        login: userInfo.login,
        accessToken: tokens.access_token,
        tokenExpiresAt,
        refreshToken,
        refreshExpiresAt,
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
    const uid = resolveOAuthUserId(req);
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
    const uid = resolveOAuthUserId(req);
    if (!uid) return res.status(401).json({ error: 'Not authenticated' });
    deleteGithubConnection(uid);
    return res.json({ ok: true });
  });

  // ── PAT (Personal Access Token) sign-in ─────────────────────────
  // Alternative to OAuth for installs that don't have githubApp.clientId
  // configured (no public URL, local-only Electron, fresh setup wizard
  // before any GitHub App exists). The user generates a fine-grained or
  // classic PAT at github.com/settings/tokens, pastes it, we validate it
  // against /user, and store it per-user in the same `users` columns the
  // OAuth flow uses. PATs don't have a refresh-token contract, so we
  // store a far-future expiry that bypasses the refresh path in
  // getActiveAccessToken; if/when the PAT expires upstream, GitHub
  // returns 401 to the consumer (PR list etc.) and the user reconnects.
  router.post('/api/auth/github/connect-token', async (req: Request, res: Response) => {
    const uid = resolveOAuthUserId(req);
    if (!uid) return res.status(401).json({ error: 'Not authenticated' });

    const tokenRaw = (req.body as { token?: string } | undefined)?.token;
    const token = typeof tokenRaw === 'string' ? tokenRaw.trim() : '';
    if (!token) {
      return res.status(400).json({ error: 'token is required' });
    }

    try {
      const userInfo = await fetchUserInfo({ accessToken: token });
      const nowMs = Date.now();
      // ~100 years out — the schema's NOT-NULL constraint on these cols
      // is satisfied with a sentinel that getActiveAccessToken will see
      // as "way beyond the refresh safety window" and return the token
      // directly without attempting a refresh.
      const farFuture = new Date(nowMs + 100 * 365 * 24 * 60 * 60 * 1000).toISOString();
      upsertGithubConnection({
        userId: uid,
        login: userInfo.login,
        accessToken: token,
        tokenExpiresAt: farFuture,
        // Mirror the access token into the refresh slot as a sentinel —
        // we never call refreshUserToken for PAT connections (no OAuth
        // creds are required because the token itself is long-lived),
        // but the column is NOT NULL.
        refreshToken: token,
        refreshExpiresAt: farFuture,
      });
      return res.json({ ok: true, login: userInfo.login });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const firstLine = msg.split('\n')[0];
      // 401 from GitHub means "bad token" — surface that explicitly so
      // the UI can say "invalid token" instead of a generic 502.
      if (firstLine.includes('(401)') || firstLine.includes('Bad credentials')) {
        return res.status(400).json({ error: 'Invalid GitHub token (GitHub rejected it)' });
      }
      console.warn(`[github-oauth] connect-token failed: ${firstLine}`);
      return res.status(502).json({ error: firstLine });
    }
  });

  return router;
}
