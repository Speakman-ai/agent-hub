import type { IncomingMessage } from 'http';
import type { Request, Response, NextFunction } from 'express';
import config from './config.js';
import { verifyJwt } from './jwt.js';
import { getAuthRecord } from './auth-store.js';
import { getActiveOrgId } from './orgs.js';
import { getUserById, getUserByUsername } from './users-store.js';
import { getMembershipRole } from './memberships-store.js';
import { verifyApiKey as verifyUserApiKey } from './api-keys-store.js';
import { sessionIdFromSpawnKeyName } from './kanban-caller-session.js';
import {
  AUTH_CODE_INVALID_SESSION,
  AUTH_CODE_NO_ACTIVE_ORG_MEMBERSHIP,
} from '../shared/utils/authErrorCodes.js';
import type { Role } from './roles.js';
import {
  buildPreviewSetCookie,
  consumePreviewCookie,
  consumePreviewTicket,
  issuePreviewCookieToken,
  isPreviewManifestAssetPath,
  matchPreviewProxyPath,
  readPreviewCookie,
} from './preview-auth.js';

/**
 * Endpoints the auth middleware always lets through. Anything that is
 * needed BEFORE a client can authenticate (health, login, invite
 * landing) must be on this list — everything else is gated by either a
 * valid JWT or a valid `X-API-Key`. Note: `/api/auth/setup` is handled
 * separately below — it is public only when no auth mechanism (neither
 * apiKey nor JWT) is configured.
 */
const PUBLIC_PATHS: readonly string[] = [
  '/api/health',
  '/api/bug-reports',
  // Public session-replay ingest (same posture as bug-reports: clients may run
  // on any origin, gated by a per-IP rate limiter). Exact-match only, so the
  // authenticated read surfaces at `/api/replays/:id[/events]` stay gated.
  '/api/replays',
  // Public, secret-free per-project replay policy (sample rate / continuous
  // opt-in) a recorder fetches at boot — same cross-origin posture as ingest.
  // Exact-match keeps the gated `:id` reads protected.
  '/api/replays/config',
  // ── Auth bootstrap endpoints ─────────────────────────────────
  '/api/auth/status',
  '/api/auth/login',
  '/api/auth/login/mfa',
  // Self-serve password reset — public + enumeration-safe; gated by per-IP
  // rate limiters in the route handlers. (Owner-issued reset-token stays gated.)
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  // GitHub OAuth callback — landed on via a cross-origin redirect from
  // github.com, so no bearer token is sent. Identity is carried by a
  // signed `state` JWT validated inside the route handler itself.
  '/api/auth/github/callback',
  // Google OAuth callback has the same cross-origin redirect shape as GitHub:
  // no Hub bearer token is present, and the route validates the signed state.
  '/api/auth/google/callback',
];

/**
 * Public paths that contain a dynamic segment and so can't be matched by
 * exact string or static prefix. Currently none — the public, unauthenticated
 * intake surface is `/api/bug-reports` (a static path matched elsewhere), which
 * lands a Customer Support ticket. The legacy project-scoped support-request
 * intake that dispatched an intake agent has been retired.
 */
const PUBLIC_PATTERNS: readonly RegExp[] = [];

/**
 * Public paths that are method-scoped: the same `:id`-bearing path is public for
 * one verb and gated for another. Chunked session-replay ingest
 * (`POST /api/replays/:id/events`, plus its CORS preflight) is unauthenticated
 * like the one-shot ingest, but the `GET` read surfaces on the same path stay
 * gated — so we can't widen `PUBLIC_PATTERNS` (method-agnostic) for it.
 */
const PUBLIC_METHOD_PATTERNS: readonly { methods: readonly string[]; re: RegExp }[] = [
  { methods: ['GET'], re: /^\/api\/auth\/invites\/[^/]+$/ },
  { methods: ['POST', 'OPTIONS'], re: /^\/api\/auth\/invites\/[^/]+\/accept$/ },
  { methods: ['POST', 'OPTIONS'], re: /^\/api\/replays\/[^/]+\/events$/ },
  // Write-only customer-log ingest (decision LOG-AUTH). These self-authenticate
  // from an `ahlog_` ingest token (Bearer / X-AgentHub-Log-Token) resolved by
  // the route, NOT a Hub session — so the auth middleware must let them through.
  // POST-only, and trailing-slash-tolerant to match Express's non-strict routing
  // and the body-parser skip regex in index.ts (both accept an optional `/`), so
  // `/api/otel/v1/logs/` can't fall through to a 401 instead of the token flow.
  { methods: ['POST'], re: /^\/api\/(?:otel\/v1\/logs|logs\/ingest)\/?$/ },
  // Write-only AWS Health ingest. Self-authenticates from an `ahhealth_` token
  // (Bearer / X-AgentHub-Health-Token) resolved by the route, presented by an
  // EventBridge API destination in the operator's own AWS account — there is no
  // Hub session behind it, so the auth middleware must let it through.
  { methods: ['POST'], re: /^\/api\/infra\/health\/ingest\/?$/ },
];

/** Public-route allowlist predicate; exported for write-only credential tests. */
export function isPublicPath(pathname: string, method: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  if (PUBLIC_PATTERNS.some((re) => re.test(pathname))) return true;
  return PUBLIC_METHOD_PATTERNS.some((p) => p.methods.includes(method) && p.re.test(pathname));
}

/**
 * Returns true iff the server is running as a single-tenant local
 * bundled install (Electron desktop, dev `npm run dev`). In that case the
 * auth gate is intentionally bypassed — the REST middleware and WS
 * handshake short-circuit to a synthetic `local` Owner identity.
 *
 * Source of truth: the `AGENT_HUB_MODE` env var, set to `'local'` by
 * trusted callers (electron/main.js when launching the embedded server,
 * or operators running a single-user dev box). Anything else — including
 * an unset env, the empty string, `'remote'`, etc. — means a multi-user
 * deployment where auth MUST be enforced.
 *
 * Why not the orgs DB? Earlier revisions read `org.mode === 'local'`
 * from sqlite, but `org.mode` is editable from the Settings UI; on a
 * remote/web deployment a single bad click would silently disable auth
 * for every visitor. The env var is set by the process that owns the
 * deployment context (Electron's main process / sysadmin's systemd
 * unit) and cannot be flipped from the UI, which makes "fail-closed"
 * the default.
 */
export function isLocalBundledServer(): boolean {
  return process.env.AGENT_HUB_MODE === 'local';
}

/** Augmented Express request populated by the middleware on success. */
export interface AuthenticatedRequest extends Request {
  /** Subject (username) when the caller used a JWT. */
  authUser?: string;
  /** Stable user id resolved from the JWT or per-user API key (Phase 3). Absent on the legacy global apiKey path. */
  authUserId?: string;
  /** True when the caller used a per-user API key (`ahub_*`) — distinct from the global apiKey break-glass. */
  authViaUserApiKey?: boolean;
  /** When auth used a per-session spawn-creds key (`spawn:<sessionId>`), the linked chat session id. */
  authSpawnSessionId?: string;
  /** Active org id at the time the request was authenticated. */
  authOrgId?: string;
  /** True when the caller used the apiKey fallback. */
  authViaApiKey?: boolean;
  /**
   * True when `isLocalBundledServer()` bypassed JWT/apiKey — the server
   * was launched in single-tenant local mode (Electron / dev box).
   * Downstream membership gates that normally require `authUserId` must
   * treat this as full access to the active org (mirrors `AuthGate`'s
   * `activeOrgIsLocal` client bypass).
   *
   * NOTE: the field name retains the historical "OrgBypass" suffix for
   * back-compat with route handlers and tests. The signal is no longer
   * tied to `org.mode` — see `isLocalBundledServer()` above.
   */
  authLocalOrgBypass?: boolean;
  /**
   * Resolved role for the authenticated caller. Populated from the
   * caller's membership in the active org (Phase 3), or forced to
   * 'Owner' when the apiKey path is taken — the apiKey is the
   * break-glass shared secret and is treated as full privilege for
   * backward compatibility.
   */
  authRole?: Role;
  /**
   * Preview-proxy GET for `*.webmanifest`. Manifest fetches omit cookies
   * per the App Manifest spec; see `isPreviewManifestAssetPath`.
   */
  authPreviewManifestBypass?: boolean;
  /**
   * True when the subdomain-dispatch middleware in `server/index.ts`
   * rewrote `req.url` from `<sid>.preview.<base>/<path>` to the
   * path-prefix mount. The auth code uses this to decide the cookie
   * `Path` scope: under subdomain mode the iframe lives at a per-
   * session origin and the cookie must be `Path=/`; under path-prefix
   * mode it stays scoped to `/api/sessions/<sid>/preview/proxy/`.
   * Defaults to undefined / false for path-prefix requests.
   */
  authPreviewArrivedViaSubdomain?: boolean;
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

/**
 * Resolve the caller behind a verified JWT to a concrete user row + role.
 * Returns `null` when the token's subject no longer maps to a user
 * (deleted) or has no membership in the active org (403-worthy), so the
 * middleware can choose the right HTTP status.
 *
 * Handles the pre-Phase-3 compatibility path: tokens issued before the
 * `uid` claim existed are re-resolved by looking up `sub` (username) in
 * the users table created by the migration.
 */
function resolveJwtCaller(payload: { sub: string; uid?: string; credentialVersion?: number }):
  | {
      userId: string;
      username: string;
      role: Role;
      orgId: string;
    }
  | null
  | 'orgs-db-unavailable'
  | 'stale-token' {
  let user = null;
  try {
    if (typeof payload.uid === 'string' && payload.uid.length > 0) {
      user = getUserById(payload.uid);
    }
    if (!user) {
      // Pre-Phase-3 token fallback: `sub` is the username.
      user = getUserByUsername(payload.sub);
    }
  } catch {
    // orgs.db isn't initialized yet (tests / mid-boot). Signal the
    // caller to fall back to the legacy auth.json role without
    // enforcing per-org membership.
    return 'orgs-db-unavailable';
  }
  if (!user) return null;
  const tokenVersion =
    typeof payload.credentialVersion === 'number' && Number.isFinite(payload.credentialVersion)
      ? payload.credentialVersion
      : 0;
  const currentVersion =
    typeof user.credential_version === 'number' && Number.isFinite(user.credential_version)
      ? user.credential_version
      : 0;
  if (tokenVersion !== currentVersion) return 'stale-token';

  const orgId = getActiveOrgId();
  const role = getMembershipRole(user.id, orgId);
  if (!role) {
    return { userId: user.id, username: user.username, role: 'User' as Role, orgId: '' };
  }
  return { userId: user.id, username: user.username, role, orgId };
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiKey = config.apiKey;
  const authRecord = getAuthRecord();

  // No auth configured at all → let everything through (dev / fresh install).
  // Treat as Owner so role-gated routes work in single-user mode.
  if (!apiKey && !authRecord) {
    const openReq = req as AuthenticatedRequest;
    openReq.authRole = 'Owner';
    try {
      openReq.authOrgId = getActiveOrgId();
    } catch {
      /* orgs.db not ready — github connect-token resolves org lazily */
    }
    next();
    return;
  }

  // Only gate /api/* — static assets / SPA HTML are always served.
  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }

  if (isPublicPath(req.path, req.method)) {
    next();
    return;
  }

  // ── Preview proxy iframe auth (ticket + path-scoped cookie) ────
  // Browsers cannot attach Authorization headers to an iframe top-level
  // navigation, so the preview proxy at
  // `/api/sessions/:sid/preview/proxy/*` accepts either a single-use
  // `?ticket=…` query param (minted via POST /preview/ticket with the
  // SPA's JWT) or a path-scoped HttpOnly cookie issued on the first
  // hit. Both populate the same `authedReq.*` fields normal JWT auth
  // would, so downstream `requireRole('User')` and ownership checks
  // see a fully-authenticated request.
  //
  // The block sits AFTER `isLocalBundledServer()`-related public paths
  // and BEFORE the standard JWT/apiKey machinery so a remote browser
  // request never reaches the "no token at all → 401" tail. Callers
  // that still send a Bearer (Electron, server-to-server) fall through
  // to the normal paths below and get the richer membership/role
  // resolution.
  const previewSessionId = matchPreviewProxyPath(req.path);
  if (previewSessionId) {
    const authedReq = req as AuthenticatedRequest;

    // Manifest sub-fetches never carry the preview cookie (spec omits
    // credentials). Synthetic User role is enough for requireRole; the
    // proxy handler skips session ownership for these public assets.
    if (req.method === 'GET' && isPreviewManifestAssetPath(req.path)) {
      authedReq.authRole = 'User';
      authedReq.authPreviewManifestBypass = true;
      next();
      return;
    }

    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : null;
    if (ticket) {
      const ctx = consumePreviewTicket(ticket, previewSessionId);
      if (ctx) {
        // Issue a path-scoped cookie so sub-resources (.js, .css, …)
        // can authenticate without each one needing a fresh ticket.
        // Under subdomain mode the iframe lives at a per-session
        // origin and the cookie must be `Path=/`; see
        // `buildPreviewSetCookie` for the rationale.
        const cookieToken = issuePreviewCookieToken(previewSessionId, ctx);
        const setCookie = buildPreviewSetCookie(previewSessionId, cookieToken, {
          secure: req.secure,
          subdomain: !!authedReq.authPreviewArrivedViaSubdomain,
        });
        // append rather than set — handlers downstream may add their
        // own cookies, and Express' `res.append('Set-Cookie', …)` is
        // multi-value-safe.
        res.append('Set-Cookie', setCookie);
        authedReq.authUser = ctx.username ?? undefined;
        authedReq.authUserId = ctx.userId ?? undefined;
        authedReq.authOrgId = ctx.orgId ?? undefined;
        authedReq.authRole = ctx.role;
        next();
        return;
      }
      // Invalid / expired / replayed ticket → do NOT give up yet. Fall
      // through to the cookie check below: a valid path-scoped cookie
      // from the first (successful) load may still be riding along.
      //
      // This is the iframe-reload case. The iframe's document URL keeps
      // the `?ticket=` query after the first nav, so any browser-initiated
      // reload (vite/ng HMR full reload, back/forward) re-requests the SAME
      // URL with the now-consumed ticket — without React re-minting a fresh
      // one. Checking the ticket first and the cookie only in an `else`
      // made that stale ticket shadow the valid cookie and 401 the reload,
      // white-screening the pane (while pop-out, which carries no ticket,
      // worked because it hit the cookie path directly).
    }
    // Cookie path — covers ticketless sub-resource fetches AND top-level
    // reloads whose stale ticket failed to consume above. Reached whether
    // or not a `?ticket=` was present, so a consumed ticket no longer
    // prevents a valid cookie from authenticating the request.
    {
      const cookieValue = readPreviewCookie(req, previewSessionId);
      if (cookieValue) {
        const ctx = consumePreviewCookie(cookieValue, previewSessionId);
        if (ctx) {
          authedReq.authUser = ctx.username ?? undefined;
          authedReq.authUserId = ctx.userId ?? undefined;
          authedReq.authOrgId = ctx.orgId ?? undefined;
          authedReq.authRole = ctx.role;
          next();
          return;
        }
        // Stale or session-mismatched cookie → fall through. The browser
        // will keep sending it until Max-Age expires, which is fine: the
        // standard auth chain runs next. If the caller also has a Bearer
        // header (e.g. Electron), that still authenticates; otherwise the
        // tail of the middleware returns 401 so the SPA can re-mint.
      }
    }
  }

  // Local bundled server (Electron / dev box) intentionally runs without
  // per-user auth. Populate a synthetic `local` Owner identity so
  // downstream handlers still see `authUser`, `authRole`, and
  // `authOrgId`, then short-circuit the JWT/apiKey branches below.
  //
  // Prefer the real Owner `users` row when auth.json exists so
  // `/api/auth/me/*` (Claude/Cursor/…) can resolve `authUserId`. Without
  // that, those routes 401 and the SPA's fetchJSON dead-session handler
  // clears the JWT + reloads into LoginScreen — the "kicked to login
  // after first project" loop on local installs.
  if (isLocalBundledServer()) {
    const r = req as AuthenticatedRequest;
    r.authUser = 'local';
    r.authRole = 'Owner';
    r.authLocalOrgBypass = true;
    try {
      r.authOrgId = getActiveOrgId();
    } catch {
      /* orgs.db not ready */
    }
    try {
      const record = getAuthRecord();
      if (record?.username) {
        const owner = getUserByUsername(record.username);
        if (owner?.id) {
          r.authUser = owner.username;
          r.authUserId = owner.id;
        }
      }
    } catch {
      /* orgs.db / users table not ready — keep synthetic local identity */
    }
    return next();
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
        const resolved = resolveJwtCaller(verified.payload!);
        if (resolved === 'orgs-db-unavailable') {
          // Pre-Phase-3 environments / tests without orgs.db bootstrap.
          // Fall back to the auth.json record's role and let the
          // request through — this matches Phase 2 behavior.
          authedReq.authUser = verified.payload!.sub;
          authedReq.authRole = authRecord.role;
          next();
          return;
        }
        if (resolved === 'stale-token') {
          res
            .status(401)
            .json({ error: 'Token is no longer valid.', code: AUTH_CODE_INVALID_SESSION });
          return;
        }
        if (!resolved) {
          // Token verified but the user row is gone (deleted after
          // token issuance). Treat as expired-ish — 401 so the client
          // knows to discard the token and re-auth.
          res
            .status(401)
            .json({ error: 'Token subject no longer exists.', code: AUTH_CODE_INVALID_SESSION });
          return;
        }
        if (!resolved.orgId) {
          // The token is valid but its holder has no membership in the
          // current active org (e.g. a token minted for a different org,
          // or the active org changed under them). This is a dead session,
          // not an ordinary "you lack permission for this resource" 403 —
          // tag it so the client can clear the token and re-auth cleanly
          // instead of stranding on a broken app.
          res.status(403).json({
            error: 'You are not a member of this org.',
            code: AUTH_CODE_NO_ACTIVE_ORG_MEMBERSHIP,
          });
          return;
        }
        authedReq.authUser = resolved.username;
        authedReq.authUserId = resolved.userId;
        authedReq.authOrgId = resolved.orgId;
        authedReq.authRole = resolved.role;
        next();
        return;
      }
      // Token was present but invalid — fall through so we can still try
      // apiKey. This lets clients mix mechanisms during migration (e.g.
      // a CLI script with an apiKey hitting a JWT-enabled server).
    }
  }

  // ── Then try per-user API keys (`ahub_*`) ──────────────────────
  // Distinct from the legacy global apiKey: each `ahub_*` token is owned
  // by a single user and grants that user's membership-derived role,
  // not Owner. Accept the token from either Authorization: Bearer or
  // the X-API-Key header so scripts can use whichever is more convenient.
  {
    const candidate = extractBearerToken(req) ?? extractApiKey(req);
    if (candidate && candidate.startsWith('ahub_')) {
      try {
        const verified = verifyUserApiKey(candidate);
        if (verified) {
          const user = getUserById(verified.userId);
          if (!user) {
            res
              .status(401)
              .json({ error: 'API key user no longer exists.', code: AUTH_CODE_INVALID_SESSION });
            return;
          }
          let orgId = '';
          try {
            orgId = getActiveOrgId();
          } catch {
            // orgs.db not initialized — leave unset, downstream handlers
            // that need orgId will 403 on their own.
          }
          const role = orgId ? getMembershipRole(verified.userId, orgId) : null;
          if (orgId && !role) {
            res.status(403).json({
              error: 'You are not a member of this org.',
              code: AUTH_CODE_NO_ACTIVE_ORG_MEMBERSHIP,
            });
            return;
          }
          authedReq.authUser = user.username;
          authedReq.authUserId = user.id;
          authedReq.authOrgId = orgId;
          authedReq.authRole = role ?? 'User';
          authedReq.authViaUserApiKey = true;
          const spawnSessionId = sessionIdFromSpawnKeyName(verified.name);
          if (spawnSessionId) authedReq.authSpawnSessionId = spawnSessionId;
          next();
          return;
        }
        // Invalid `ahub_*` token: reject explicitly rather than falling
        // through. A client with a clearly-shaped key that doesn't
        // match should get a 401, not silently fall back to the global
        // apiKey check (which would leak whether the global is set).
        res.status(401).json({ error: 'Invalid API key.', code: AUTH_CODE_INVALID_SESSION });
        return;
      } catch {
        // orgs.db not initialized in some test paths — fall through to
        // the legacy global apiKey check.
      }
    }
  }

  // ── Then fall back to the legacy X-API-Key ─────────────────────
  if (apiKey) {
    const provided = extractApiKey(req);
    if (provided && provided === apiKey) {
      authedReq.authViaApiKey = true;
      // The apiKey is the break-glass shared secret; treat it as full
      // privilege so existing CLI scripts keep working.
      authedReq.authRole = 'Owner';
      try {
        authedReq.authOrgId = getActiveOrgId();
      } catch {
        // orgs.db not initialized in some test harnesses — leave unset.
      }
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
      code: AUTH_CODE_INVALID_SESSION,
    });
    return;
  }
  res.status(401).json({
    error: 'API key required. Set X-API-Key header or ?apiKey= query param.',
    code: AUTH_CODE_INVALID_SESSION,
  });
}

export interface WsAuthResult {
  ok: boolean;
  subject?: string;
  userId?: string;
  orgId?: string;
  role?: Role;
  viaApiKey?: boolean;
  /** When `ok === false`, a short reason so callers can log / close-code. */
  reason?: 'unauthenticated' | 'no-membership' | 'unknown-user';
}

/**
 * WebSocket authentication. Accepts either:
 *   - `?token=<jwt>` — Bearer-equivalent for WS (the browser can't set
 *     custom headers on a `new WebSocket(...)` handshake).
 *   - `?apiKey=<key>` — legacy API-key mechanism.
 *
 * Phase 3: tokens that verify but don't map to a current user, or whose
 * user has no membership in the active org, are rejected with a
 * structured reason so the server can close the handshake cleanly.
 */
export function authenticateWsDetailed(request: IncomingMessage): WsAuthResult {
  const apiKey = config.apiKey;
  const authRecord = getAuthRecord();
  if (!apiKey && !authRecord) return { ok: true };

  // Local bundled server: mirror the REST bypass — return a synthetic
  // `local` Owner handshake so the WS session has an attributable
  // identity without requiring a token.
  if (isLocalBundledServer()) {
    let orgId = '';
    try {
      orgId = getActiveOrgId();
    } catch {}
    return { ok: true, subject: 'local', role: 'Owner', orgId };
  }

  const url = new URL(request.url!, `http://${request.headers.host}`);
  if (authRecord) {
    const token = url.searchParams.get('token');
    if (token) {
      const verified = verifyJwt(token, authRecord.jwtSecret);
      if (verified.ok) {
        const resolved = resolveJwtCaller(verified.payload!);
        if (resolved === 'orgs-db-unavailable') {
          return { ok: true, subject: verified.payload!.sub, role: authRecord.role };
        }
        if (resolved === 'stale-token') return { ok: false, reason: 'unauthenticated' };
        if (!resolved) return { ok: false, reason: 'unknown-user' };
        if (!resolved.orgId) return { ok: false, reason: 'no-membership' };
        return {
          ok: true,
          subject: resolved.username,
          userId: resolved.userId,
          orgId: resolved.orgId,
          role: resolved.role,
        };
      }
    }
  }
  // Per-user API key (`ahub_*`) over WS — accepted via ?apiKey= or ?token=.
  {
    const candidate = url.searchParams.get('token') || url.searchParams.get('apiKey') || '';
    if (candidate.startsWith('ahub_')) {
      try {
        const verified = verifyUserApiKey(candidate);
        if (verified) {
          const user = getUserById(verified.userId);
          if (!user) return { ok: false, reason: 'unknown-user' };
          let orgId = '';
          try {
            orgId = getActiveOrgId();
          } catch {}
          const role = orgId ? getMembershipRole(verified.userId, orgId) : null;
          if (orgId && !role) return { ok: false, reason: 'no-membership' };
          return {
            ok: true,
            subject: user.username,
            userId: user.id,
            orgId,
            role: role ?? 'User',
          };
        }
        return { ok: false, reason: 'unauthenticated' };
      } catch {
        // orgs.db unavailable — fall through to global apiKey check.
      }
    }
  }
  if (apiKey) {
    const provided = url.searchParams.get('apiKey');
    if (provided && provided === apiKey) {
      return { ok: true, viaApiKey: true, role: 'Owner' };
    }
  }
  return { ok: false, reason: 'unauthenticated' };
}

/** Back-compat boolean wrapper used by the existing WebSocket setup. */
export function authenticateWs(request: IncomingMessage): boolean {
  return authenticateWsDetailed(request).ok;
}
