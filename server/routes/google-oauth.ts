/**
 * "Connect Google" user-identity endpoints.
 *
 *   GET    /api/auth/google/start    — returns { authorizeUrl }; client redirects the browser.
 *   GET    /api/auth/google/callback — public; verifies state, exchanges code, stores the
 *                                      encrypted per-user connection, redirects back to the UI.
 *   GET    /api/auth/google/status   — { connected, email, grantedScopes, accounts, … } (never tokens).
 *   POST   /api/auth/google/accounts/:accountId/default — make one linked account the default.
 *   DELETE /api/auth/google/accounts/:accountId          — revoke + remove one linked account.
 *   DELETE /api/auth/google/connect  — revoke + remove the default account (older clients).
 *
 * Connections are per-USER (mirrors GitHub), surfaced in Account settings. A user
 * can link several Google accounts; one is the default that callers get when they
 * don't name an account. `/start?intent=add` forces Google's account chooser;
 * `/start?accountId=…` re-consents a specific account (incremental scopes). The
 * callback always upserts by (user, google_sub), so re-linking an account refreshes
 * its row and a new Google account adds one. Tokens
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
  listGoogleConnections,
  setDefaultGoogleConnection,
  type GoogleConnectionRow,
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

const GoogleAccountSummarySchema = z
  .object({
    accountId: z.string(),
    email: z.string(),
    grantedScopes: z.array(z.string()),
    isDefault: z.boolean(),
    connectedAt: z.string(),
    tokenExpiresAt: z.string().nullable(),
  })
  .openapi('GoogleAccountSummary');

const ErrorBodySchema = z.object({ error: z.string() });
const AccountIdParamsSchema = z.object({ accountId: z.string().min(1) });

registerPath({
  method: 'get',
  path: '/api/auth/google/status',
  tags: ['Auth'],
  summary: 'Google connection status for the calling user (never returns tokens).',
  description:
    'Top-level `email` / `grantedScopes` / `connectedAt` / `tokenExpiresAt` describe the default account (kept for single-account clients). `accounts` lists every linked account, default first.',
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
            defaultAccountId: z.string().nullable(),
            accounts: z.array(GoogleAccountSummarySchema),
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
  summary: 'Disconnect the default Google account (revoke + clear).',
  description:
    'Kept for single-account clients. Removes only the default account; the oldest remaining account becomes the default. Use DELETE /api/auth/google/accounts/{accountId} to remove a specific account.',
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

registerPath({
  method: 'post',
  path: '/api/auth/google/accounts/{accountId}/default',
  tags: ['Auth'],
  summary: "Make one of the calling user's linked Google accounts the default.",
  request: { params: AccountIdParamsSchema },
  responses: {
    200: {
      description: 'Default moved.',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    404: {
      description: 'No linked account with that id for this user.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
  },
});

registerPath({
  method: 'delete',
  path: '/api/auth/google/accounts/{accountId}',
  tags: ['Auth'],
  summary: 'Disconnect one linked Google account (revoke + clear).',
  description: 'Removing the default account promotes the oldest remaining account to default.',
  request: { params: AccountIdParamsSchema },
  responses: {
    200: {
      description: 'Disconnected.',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    404: {
      description: 'No linked account with that id for this user.',
      content: { 'application/json': { schema: ErrorBodySchema } },
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
  /**
   * `add` links another Google account (the chooser was forced); `reconnect`
   * re-consents an already-linked account. Either way the callback upserts by
   * google_sub, so the intent only changes the result page copy and lets the
   * callback notice the user picked a different account than requested.
   */
  intent?: GoogleOAuthIntent;
  /** Account being re-consented (reconnect intent only). */
  accountId?: string;
}

type GoogleOAuthIntent = 'add' | 'reconnect';

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
      intent: z.enum(['add', 'reconnect']).optional().openapi({
        description:
          '`add` links another Google account and forces the account chooser (`prompt=select_account consent`). `reconnect` (the default when the user already has an account) re-consents an existing account.',
      }),
      accountId: z.string().optional().openapi({
        description:
          'Linked account to re-consent (implies `reconnect`). Its email is sent as `login_hint`. Defaults to the default account.',
      }),
    }),
  },
  responses: {
    200: {
      description: 'Authorize URL the client should redirect the browser to.',
      content: { 'application/json': { schema: z.object({ authorizeUrl: z.string() }) } },
    },
    400: {
      description: 'Invalid intent, or `accountId` combined with `intent=add`.',
      content: { 'application/json': { schema: ErrorBodySchema } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: z.object({ error: z.string() }) } },
    },
    404: {
      description: "`accountId` is not one of the caller's linked accounts.",
      content: { 'application/json': { schema: ErrorBodySchema } },
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

function callbackSuccessTitle(opts: {
  email: string;
  alreadyLinked: boolean;
  intent: GoogleOAuthIntent | undefined;
}): string {
  if (!opts.email) return 'Google connected';
  if (opts.intent === 'add' && opts.alreadyLinked) return `${opts.email} is already linked`;
  if (opts.alreadyLinked) return `Reconnected ${opts.email}`;
  return `Connected as ${opts.email}`;
}

/**
 * Best-effort revoke at Google, then remove the local row. Revoking the refresh
 * token drops the grant for that Google account only. revokeGoogleToken never
 * throws, so a failed revoke can't strand the local connection.
 */
async function revokeAndDelete(userId: string, conn: GoogleConnectionRow): Promise<void> {
  const tokenToRevoke = conn.refreshToken || conn.accessToken;
  if (tokenToRevoke) {
    await revokeGoogleToken({ token: tokenToRevoke });
  }
  deleteGoogleConnection(userId, { accountId: conn.accountId });
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

    const rawIntent = req.query.intent;
    if (rawIntent !== undefined && rawIntent !== 'add' && rawIntent !== 'reconnect') {
      return res.status(400).json({ error: 'intent must be "add" or "reconnect"' });
    }
    const accountIdParam =
      typeof req.query.accountId === 'string' && req.query.accountId ? req.query.accountId : null;
    if (rawIntent === 'add' && accountIdParam) {
      return res.status(400).json({ error: 'accountId cannot be combined with intent=add' });
    }

    let intent: GoogleOAuthIntent;
    let target: GoogleConnectionRow | null = null;
    if (rawIntent === 'add') {
      intent = 'add';
    } else {
      target = getGoogleConnection(uid, accountIdParam ? { accountId: accountIdParam } : undefined);
      if (accountIdParam && !target) {
        return res.status(404).json({ error: 'Google account not found' });
      }
      // With nothing linked yet, a plain connect is the first add.
      intent = target ? 'reconnect' : 'add';
    }

    const stateToken = signJwt(uid, record.jwtSecret, {
      expiresInSec: STATE_TOKEN_TTL_SEC,
      claims: {
        purpose: STATE_PURPOSE,
        intent,
        ...(target && { accountId: target.accountId }),
        ...(returnTo && { returnTo }),
      },
    });

    const authorizeUrl = buildAuthorizeUrl({
      clientId: creds.clientId,
      redirectUri: getRedirectUri(config, req),
      state: stateToken,
      scopes: parseScopesParam(req.query.scopes),
      ...(target?.googleEmail && { loginHint: target.googleEmail }),
      selectAccount: rawIntent === 'add',
    });

    return res.json({ authorizeUrl });
  });

  // Callback: verify state, exchange code, persist encrypted tokens
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
        tokens.refresh_token ||
        listGoogleConnections(callerUserId).find((c) => c.googleSub === userInfo.sub)
          ?.refreshToken ||
        null;
      const alreadyLinked = listGoogleConnections(callerUserId).some(
        (c) => c.googleSub === userInfo.sub,
      );
      upsertGoogleConnection({
        userId: callerUserId,
        googleSub: userInfo.sub,
        googleEmail: userInfo.email,
        accessToken: tokens.access_token,
        tokenExpiresAt,
        refreshToken,
        grantedScopes: parseGrantedScopes(tokens.scope),
      });
      const resultTitle = callbackSuccessTitle({
        email: userInfo.email,
        alreadyLinked,
        intent: payload.intent,
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
            title: resultTitle,
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

  // Status: for the Account settings UI. Never returns tokens.
  router.get('/api/auth/google/status', (req: Request, res: Response) => {
    const uid = resolveOAuthConnectionUserId(req);
    if (!uid) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const status = getGoogleConnectionStatus(uid);
    const accounts = listGoogleConnections(uid).map((c) => ({
      accountId: c.accountId,
      email: c.googleEmail,
      grantedScopes: c.grantedScopes,
      isDefault: c.isDefault,
      connectedAt: c.connectedAt,
      tokenExpiresAt: c.tokenExpiresAt,
    }));
    const creds = config.googleOAuth;
    return res.json({
      ...status,
      serverConfigured: !!(creds?.clientId && creds?.clientSecret),
      defaultAccountId: accounts.find((a) => a.isDefault)?.accountId ?? null,
      accounts,
    });
  });

  // Disconnect: best-effort revoke at Google, then clear the row
  router.delete('/api/auth/google/connect', async (req: Request, res: Response) => {
    const uid = resolveOAuthConnectionUserId(req);
    if (!uid) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const conn = getGoogleConnection(uid);
    if (conn) await revokeAndDelete(uid, conn);
    return res.json({ ok: true });
  });

  router.post('/api/auth/google/accounts/:accountId/default', (req: Request, res: Response) => {
    const uid = resolveOAuthConnectionUserId(req);
    if (!uid) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const params = AccountIdParamsSchema.safeParse(req.params);
    if (!params.success || !setDefaultGoogleConnection(uid, params.data.accountId)) {
      return res.status(404).json({ error: 'Google account not found' });
    }
    return res.json({ ok: true });
  });

  router.delete('/api/auth/google/accounts/:accountId', async (req: Request, res: Response) => {
    const uid = resolveOAuthConnectionUserId(req);
    if (!uid) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const params = AccountIdParamsSchema.safeParse(req.params);
    const conn = params.success
      ? getGoogleConnection(uid, { accountId: params.data.accountId })
      : null;
    if (!conn) {
      return res.status(404).json({ error: 'Google account not found' });
    }
    await revokeAndDelete(uid, conn);
    return res.json({ ok: true });
  });

  return router;
}
