/**
 * Preview-URL auth (W2).
 *
 * Sits in front of PR preview envs (`pr-<n>.<previewHost>`) and decides
 * whether an incoming request is allowed to reach the container. Two
 * authentication paths, both terminating in a signed session cookie:
 *
 *   1. **GitHub OAuth + org-member check** — for engineers. Unauthenticated
 *      requests are 302-redirected to GitHub's OAuth authorize endpoint.
 *      The callback exchanges the code for a *user* access token, then
 *      calls `GET /orgs/{org}/members/{username}` with that token — 204 =
 *      member (allow), 302/404 = non-member (deny, 403). The client_id/
 *      secret come from the OAuth settings of the existing GitHub App
 *      (distinct from the app installation token used for API calls).
 *
 *   2. **Magic-link fallback** — for non-engineer reviewers (designers,
 *      PMs, external stakeholders). Per-PR tokens issued from a
 *      `/preview/auth/magic-link` admin endpoint, with a configurable TTL
 *      (default 7 days). The emailable URL looks like
 *      `https://pr-NNN.<preview-domain>/?mlk=<opaque-token>`; the
 *      middleware reads `mlk`, hashes it, and looks up the row. Valid
 *      tokens mint a session cookie scoped to exactly that PR.
 *
 * Design notes:
 *
 *   - Tokens are **hashed at rest** (sha256, no salt — tokens are 32
 *     random bytes, so pre-image resistance on the hash is overkill; the
 *     hash's purpose is to prevent a DB leak from yielding live tokens).
 *   - Session cookies are **signed, not encrypted**. Cookie body is
 *     `<session_id>.<hmac>`. Verification is constant-time.
 *     HttpOnly + Secure + SameSite=Lax, signed with `SESSION_SECRET`.
 *   - All network / time / db I/O is injectable: `PreviewAuthDeps` holds
 *     a `now()`, `randomBytes()`, `fetch()`, and the raw `Database`
 *     handle. Tests pass in frozen-clock + mocked fetch.
 *   - This module is pure logic — no Express app is created here. The
 *     companion `createPreviewAuthRoutes()` factory in a sibling file
 *     (`preview-auth-routes.ts`) wires these into an Express router.
 */

import type { Database } from 'better-sqlite3';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createHash, createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'crypto';

// ─── Constants / config ───────────────────────────────────────────────────

/** Default magic-link TTL — 7 days. Overridable per call. */
export const DEFAULT_MAGIC_LINK_TTL_SECONDS = 60 * 60 * 24 * 7;

/** Default OAuth session TTL — 12 hours, matching typical engineer work sessions. */
export const DEFAULT_OAUTH_SESSION_TTL_SECONDS = 60 * 60 * 12;

/** Cookie name carrying the signed preview-auth session. */
export const PREVIEW_SESSION_COOKIE = 'preview_auth_session';

/** Cookie name holding the OAuth CSRF state, set on the login redirect. */
export const PREVIEW_STATE_COOKIE = 'preview_auth_state';

/** Query-string key for a magic-link token. */
export const MAGIC_LINK_QUERY_PARAM = 'mlk';

// ─── Types ────────────────────────────────────────────────────────────────

export interface PreviewAuthConfig {
  /** GitHub OAuth client id (from the GitHub App's OAuth settings). */
  githubClientId: string;
  /** GitHub OAuth client secret. */
  githubClientSecret: string;
  /** GitHub org the reviewer must belong to for OAuth auth. */
  githubOrg: string;
  /**
   * Base URL callbacks redirect to, e.g. `https://preview.agenthub.dev`.
   * The preview-host router wires `GET <baseUrl>/preview/auth/callback`
   * and `GET <baseUrl>/preview/auth/login` to this module's routes.
   */
  baseUrl: string;
  /**
   * HMAC secret used to sign session cookies + OAuth state. MUST be
   * distinct from the main Agent Hub `SESSION_SECRET` if that's reused
   * for other signing surfaces — rotation-independent.
   */
  sessionSecret: string;
  /** OAuth session cookie TTL in seconds. Default 12h. */
  oauthSessionTtlSeconds?: number;
  /** Magic-link TTL in seconds. Default 7 days. */
  magicLinkTtlSeconds?: number;
  /**
   * When true (default in prod), cookies are emitted with `Secure`.
   * Tests + local dev over plain HTTP can flip this off.
   */
  secureCookies?: boolean;
  /**
   * Cookie `Domain` attribute. CRITICAL for the OAuth flow because the
   * middleware runs on `pr-N.<previewHost>` while the callback lives at
   * `<baseUrl>/preview/auth/callback` (typically `preview.<domain>` — a
   * sibling subdomain). Host-only cookies set by the middleware would
   * not be sent to the callback.
   *
   * Set to the parent domain covered by the wildcard, e.g.
   * `.preview.agenthub.dev` (leading dot is optional in RFC 6265bis; we
   * keep it for clarity). Unset → cookies are host-only (correct when
   * middleware + callback share the same host; tests).
   */
  cookieDomain?: string;
}

export interface PreviewAuthDeps {
  db: Database;
  config: PreviewAuthConfig;
  /** Injectable clock for deterministic TTL tests. Defaults to Date.now. */
  now?: () => number;
  /** Injectable RNG — lets tests produce predictable tokens. */
  randomBytes?: (size: number) => Buffer;
  /** Injectable HTTP — lets tests mock the GitHub API without nock. */
  fetch?: typeof fetch;
}

interface ResolvedConfig {
  githubClientId: string;
  githubClientSecret: string;
  githubOrg: string;
  baseUrl: string;
  sessionSecret: string;
  oauthSessionTtlSeconds: number;
  magicLinkTtlSeconds: number;
  secureCookies: boolean;
  /** Null when unset — serializeCookie simply omits the Domain attribute. */
  cookieDomain: string | null;
}

interface ResolvedDeps {
  db: Database;
  config: ResolvedConfig;
  now: () => number;
  randomBytes: (size: number) => Buffer;
  fetch: typeof fetch;
}

function resolve(deps: PreviewAuthDeps): ResolvedDeps {
  return {
    db: deps.db,
    config: {
      githubClientId: deps.config.githubClientId,
      githubClientSecret: deps.config.githubClientSecret,
      githubOrg: deps.config.githubOrg,
      baseUrl: deps.config.baseUrl.replace(/\/+$/, ''),
      sessionSecret: deps.config.sessionSecret,
      oauthSessionTtlSeconds:
        deps.config.oauthSessionTtlSeconds ?? DEFAULT_OAUTH_SESSION_TTL_SECONDS,
      magicLinkTtlSeconds: deps.config.magicLinkTtlSeconds ?? DEFAULT_MAGIC_LINK_TTL_SECONDS,
      secureCookies: deps.config.secureCookies ?? true,
      cookieDomain: deps.config.cookieDomain ?? null,
    },
    now: deps.now ?? (() => Date.now()),
    randomBytes: deps.randomBytes ?? ((n: number) => nodeRandomBytes(n)),
    fetch: deps.fetch ?? fetch,
  };
}

// ─── Token / hash helpers ─────────────────────────────────────────────────

/** sha256(token) → hex. No salt — tokens are 32 random bytes, pre-image is trivial. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Produce a URL-safe opaque token (base64url, 32 bytes of entropy). */
export function generateOpaqueToken(rng: (n: number) => Buffer = nodeRandomBytes): string {
  return rng(32).toString('base64url');
}

// ─── Signed session cookie (HMAC) ─────────────────────────────────────────

/** Format: `<session_id>.<base64url-hmac>`. Verified in constant time. */
export function signSessionCookie(sessionId: string, secret: string): string {
  const hmac = createHmac('sha256', secret).update(sessionId, 'utf8').digest('base64url');
  return `${sessionId}.${hmac}`;
}

/** Returns the session_id on success, null on signature mismatch / malformed. */
export function verifySessionCookie(cookieValue: string, secret: string): string | null {
  const dot = cookieValue.lastIndexOf('.');
  if (dot <= 0 || dot === cookieValue.length - 1) return null;
  const sessionId = cookieValue.slice(0, dot);
  const provided = cookieValue.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(sessionId, 'utf8').digest('base64url');
  // Constant-time compare. Buffers MUST be equal length — otherwise the
  // signature is definitely wrong.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? sessionId : null;
}

// ─── DB row shapes ────────────────────────────────────────────────────────

interface MagicLinkRow {
  token_hash: string;
  pr_number: number;
  expires_at: string;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
}

interface PreviewSessionRow {
  session_id: string;
  kind: 'oauth' | 'magic_link';
  github_login: string | null;
  pr_number: number | null;
  expires_at: string;
  created_at: string;
}

// ─── Magic-link store ─────────────────────────────────────────────────────

export interface IssuedMagicLink {
  /** The raw plaintext token — return to caller once, then discard. */
  token: string;
  prNumber: number;
  expiresAt: string;
  createdBy: string;
}

/**
 * Mint a new magic-link token scoped to a single PR. Returns the raw
 * plaintext — caller emails it to the reviewer and drops it. DB stores
 * only the sha256 hash.
 */
export function issueMagicLink(
  deps: PreviewAuthDeps,
  args: { prNumber: number; createdBy: string; ttlSeconds?: number },
): IssuedMagicLink {
  const d = resolve(deps);
  if (!Number.isInteger(args.prNumber) || args.prNumber <= 0) {
    throw new Error('issueMagicLink: prNumber must be a positive integer');
  }
  if (!args.createdBy) {
    throw new Error('issueMagicLink: createdBy is required');
  }
  const ttl = args.ttlSeconds ?? d.config.magicLinkTtlSeconds;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error('issueMagicLink: ttlSeconds must be positive');
  }
  const token = generateOpaqueToken(d.randomBytes);
  const hash = hashToken(token);
  const nowMs = d.now();
  const expiresAt = new Date(nowMs + ttl * 1000).toISOString();
  d.db
    .prepare(
      `INSERT INTO preview_magic_links (token_hash, pr_number, expires_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(hash, args.prNumber, expiresAt, args.createdBy, new Date(nowMs).toISOString());
  return { token, prNumber: args.prNumber, expiresAt, createdBy: args.createdBy };
}

/**
 * Look up a magic link by its plaintext token, returning the row if it
 * exists, is for the given PR, is not expired, and is not revoked.
 * Returns null otherwise — callers MUST NOT expose the difference
 * between "no such token" and "expired" to clients.
 */
export function redeemMagicLink(
  deps: PreviewAuthDeps,
  args: { token: string; prNumber: number },
): { ok: true; row: MagicLinkRow } | { ok: false; reason: 'invalid' | 'expired' | 'wrong_pr' } {
  const d = resolve(deps);
  const hash = hashToken(args.token);
  const row = d.db
    .prepare(
      `SELECT token_hash, pr_number, expires_at, created_by, created_at, revoked_at
         FROM preview_magic_links WHERE token_hash = ?`,
    )
    .get(hash) as MagicLinkRow | undefined;
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.revoked_at) return { ok: false, reason: 'invalid' };
  if (row.pr_number !== args.prNumber) return { ok: false, reason: 'wrong_pr' };
  const expiresMs = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresMs) || expiresMs <= d.now()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, row };
}

/** Revoke a magic link by plaintext token. Returns true if a row was updated. */
export function revokeMagicLink(deps: PreviewAuthDeps, token: string): boolean {
  const d = resolve(deps);
  const hash = hashToken(token);
  const res = d.db
    .prepare(
      `UPDATE preview_magic_links SET revoked_at = ?
         WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .run(new Date(d.now()).toISOString(), hash);
  return res.changes > 0;
}

// ─── Session store ────────────────────────────────────────────────────────

export interface CreatedSession {
  sessionId: string;
  cookieValue: string;
  kind: 'oauth' | 'magic_link';
  githubLogin: string | null;
  prNumber: number | null;
  expiresAt: string;
  maxAgeSeconds: number;
}

function createSessionRow(
  deps: ResolvedDeps,
  args: {
    kind: 'oauth' | 'magic_link';
    githubLogin?: string | null;
    prNumber?: number | null;
    ttlSeconds: number;
  },
): CreatedSession {
  const sessionId = generateOpaqueToken(deps.randomBytes);
  const nowMs = deps.now();
  const expiresAt = new Date(nowMs + args.ttlSeconds * 1000).toISOString();
  deps.db
    .prepare(
      `INSERT INTO preview_auth_sessions (session_id, kind, github_login, pr_number, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      args.kind,
      args.githubLogin ?? null,
      args.prNumber ?? null,
      expiresAt,
      new Date(nowMs).toISOString(),
    );
  return {
    sessionId,
    cookieValue: signSessionCookie(sessionId, deps.config.sessionSecret),
    kind: args.kind,
    githubLogin: args.githubLogin ?? null,
    prNumber: args.prNumber ?? null,
    expiresAt,
    maxAgeSeconds: args.ttlSeconds,
  };
}

/** Look up a preview session by signed cookie value. Returns null on mismatch or expiry. */
export function verifyPreviewSession(
  deps: PreviewAuthDeps,
  cookieValue: string,
): PreviewSessionRow | null {
  const d = resolve(deps);
  const sessionId = verifySessionCookie(cookieValue, d.config.sessionSecret);
  if (!sessionId) return null;
  const row = d.db
    .prepare(
      `SELECT session_id, kind, github_login, pr_number, expires_at, created_at
         FROM preview_auth_sessions WHERE session_id = ?`,
    )
    .get(sessionId) as PreviewSessionRow | undefined;
  if (!row) return null;
  const expiresMs = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresMs) || expiresMs <= d.now()) return null;
  return row;
}

// ─── OAuth helpers ────────────────────────────────────────────────────────

/**
 * Build the GitHub authorize URL. `state` is a random one-shot value
 * stored in a cookie and echoed back — prevents login CSRF.
 *
 * The post-auth destination host + path are NOT passed through GitHub —
 * they're stored in the signed state cookie so the callback can restore
 * them without trusting user-supplied query params.
 */
export function buildAuthorizeUrl(deps: PreviewAuthDeps, args: { state: string }): string {
  const d = resolve(deps);
  const params = new URLSearchParams({
    client_id: d.config.githubClientId,
    redirect_uri: `${d.config.baseUrl}/preview/auth/callback`,
    // `read:org` is required for the org membership check; default scopes
    // (no value) give public user info only. We intentionally do NOT ask
    // for repo scope.
    scope: 'read:org user:email',
    state: args.state,
    allow_signup: 'false',
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

export interface GitHubUserResponse {
  login: string;
  id: number;
}

/** Exchange an authorization code for a user access token. */
export async function exchangeCodeForToken(
  deps: PreviewAuthDeps,
  args: { code: string },
): Promise<GitHubTokenResponse> {
  const d = resolve(deps);
  const res = await d.fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: d.config.githubClientId,
      client_secret: d.config.githubClientSecret,
      code: args.code,
      redirect_uri: `${d.config.baseUrl}/preview/auth/callback`,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub token exchange failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as Partial<GitHubTokenResponse> & { error?: string };
  if (!body.access_token) {
    throw new Error(
      `GitHub token exchange returned no access_token: ${body.error ?? 'unknown error'}`,
    );
  }
  return {
    access_token: body.access_token,
    token_type: body.token_type ?? 'bearer',
    scope: body.scope ?? '',
  };
}

/** Fetch the authenticated user's `login` from `/user`. */
export async function fetchGitHubUser(
  deps: PreviewAuthDeps,
  args: { accessToken: string },
): Promise<GitHubUserResponse> {
  const d = resolve(deps);
  const res = await d.fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GET /user failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as Partial<GitHubUserResponse>;
  if (!body.login) throw new Error(`GET /user returned no login field`);
  return { login: body.login, id: body.id ?? 0 };
}

/**
 * Check org membership via the *user* token. GitHub semantics:
 *   204 — user is a member of the org
 *   302 — requester is not a member (redirected to public profile)
 *   404 — user is not a member (or org is private and you can't see)
 *
 * We treat 204 as allow and everything else as deny. 302 is reported by
 * fetch with `redirect: 'manual'`; without that, fetch follows redirects
 * and surfaces as a 200 on the redirected resource — which would be a
 * false positive. Hence `redirect: 'manual'`.
 */
export async function checkOrgMembership(
  deps: PreviewAuthDeps,
  args: { accessToken: string; username: string },
): Promise<boolean> {
  const d = resolve(deps);
  const res = await d.fetch(
    `https://api.github.com/orgs/${encodeURIComponent(d.config.githubOrg)}/members/${encodeURIComponent(args.username)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'manual',
    },
  );
  return res.status === 204;
}

/** Convenience combiner used by the callback route. */
export async function completeOAuthFlow(
  deps: PreviewAuthDeps,
  args: { code: string },
): Promise<
  | { ok: true; session: CreatedSession }
  | { ok: false; reason: 'not_member' | 'token_exchange_failed'; detail?: string }
> {
  try {
    const token = await exchangeCodeForToken(deps, { code: args.code });
    const user = await fetchGitHubUser(deps, { accessToken: token.access_token });
    const member = await checkOrgMembership(deps, {
      accessToken: token.access_token,
      username: user.login,
    });
    if (!member) return { ok: false, reason: 'not_member' };
    const d = resolve(deps);
    const session = createSessionRow(d, {
      kind: 'oauth',
      githubLogin: user.login,
      ttlSeconds: d.config.oauthSessionTtlSeconds,
    });
    return { ok: true, session };
  } catch (e) {
    return {
      ok: false,
      reason: 'token_exchange_failed',
      detail: (e as Error).message,
    };
  }
}

/** Exchange a redeemed magic-link row for a session cookie. */
export function completeMagicLinkFlow(
  deps: PreviewAuthDeps,
  args: { prNumber: number; token: string },
):
  | { ok: true; session: CreatedSession }
  | { ok: false; reason: 'invalid' | 'expired' | 'wrong_pr' } {
  const redemption = redeemMagicLink(deps, args);
  if (!redemption.ok) return redemption;
  const d = resolve(deps);
  const session = createSessionRow(d, {
    kind: 'magic_link',
    prNumber: args.prNumber,
    // Magic-link session expires alongside the link itself — never past
    // the link's TTL. Don't grant a 12h session from a token that's about
    // to expire in 30s.
    ttlSeconds: Math.max(1, Math.floor((Date.parse(redemption.row.expires_at) - d.now()) / 1000)),
  });
  return { ok: true, session };
}

// ─── Host / cookie parsing ────────────────────────────────────────────────

/**
 * Extract the PR number from a preview host like `pr-42.preview.agenthub.dev`.
 * Returns null for non-preview hosts.
 */
export function extractPrNumberFromHost(host: string | undefined): number | null {
  if (!host) return null;
  // Strip port if present.
  const hostOnly = host.split(':')[0];
  // Case-sensitive: DNS is canonically lowercase and the wiki spec is
  // unambiguous about `pr-<n>`. Matching `PR-42.…` would only mask a
  // mis-rendered nginx block, not accommodate a real deployment.
  const match = /^pr-(\d+)\./.exec(hostOnly);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Parse a raw Cookie header into a name → value map. Case-sensitive names. */
export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(value);
  }
  return out;
}

/** Serialize a single Set-Cookie header value. */
export function serializeCookie(
  name: string,
  value: string,
  opts: {
    maxAgeSeconds?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Lax' | 'Strict' | 'None';
    path?: string;
    domain?: string;
  } = {},
): string {
  const parts: string[] = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAgeSeconds)}`);
  parts.push(`Path=${opts.path ?? '/'}`);
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

// ─── Express middleware ───────────────────────────────────────────────────

/**
 * Gate preview-env requests. Flow:
 *
 *   1. If `?mlk=<token>` is present, try to redeem it for the host's PR.
 *      On success, set a scoped session cookie and 302 to the same URL
 *      minus `?mlk=` so the token doesn't leak into referrer headers.
 *   2. Else, look for a signed session cookie. Valid cookie → allow.
 *      If the cookie is scoped (magic-link), require PR number match.
 *   3. Else, 302 to `/preview/auth/login?next=<original-url>` which
 *      kicks off the GitHub OAuth flow.
 *
 * The middleware is deliberately transport-agnostic — it relies on
 * `req.headers`, `req.url`, and `res.setHeader`/`res.end` only, so it
 * can be unit-tested with fake req/res objects.
 */
export function createPreviewAuthMiddleware(deps: PreviewAuthDeps): RequestHandler {
  const d = resolve(deps);
  return function previewAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
    const host = req.headers.host;
    const prNumber = extractPrNumberFromHost(host);
    if (prNumber === null) {
      // Not a preview host — let it through. The ordinary app routes
      // handle their own auth.
      next();
      return;
    }

    const url = new URL(req.url, `http://${host ?? 'localhost'}`);

    // ── Path 1: magic-link token in query string.
    const mlk = url.searchParams.get(MAGIC_LINK_QUERY_PARAM);
    if (mlk) {
      const flow = completeMagicLinkFlow(deps, { prNumber, token: mlk });
      if (flow.ok) {
        // Strip the token from the URL before the browser stores it
        // anywhere. Set the session cookie and 302 to the cleaned URL.
        url.searchParams.delete(MAGIC_LINK_QUERY_PARAM);
        const cleanPath = `${url.pathname}${url.search}${url.hash}`;
        res.setHeader(
          'Set-Cookie',
          serializeCookie(PREVIEW_SESSION_COOKIE, flow.session.cookieValue, {
            maxAgeSeconds: flow.session.maxAgeSeconds,
            httpOnly: true,
            secure: d.config.secureCookies,
            sameSite: 'Lax',
            // Magic-link sessions stay on the single PR host — the
            // parent-domain cookie is only needed for the OAuth flow
            // where middleware + callback live on different hosts.
            // Keep host-only here so the cookie never leaks to sibling
            // PR envs (the 403 wrong-PR check is a backstop, not the
            // primary boundary).
          }),
        );
        res.statusCode = 302;
        res.setHeader('Location', cleanPath);
        res.end();
        return;
      }
      // Explicit magic-link presented but rejected — return 401 rather
      // than silently redirecting to OAuth. The reviewer intentionally
      // used their link; telling them it's dead is more useful than
      // bouncing them to a GitHub login page they probably can't pass.
      // Body text is distinct per reason so ops can eyeball problems.
      res.statusCode = 401;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      const body =
        flow.reason === 'expired'
          ? 'Magic link has expired. Ask the PR author for a new one.'
          : flow.reason === 'wrong_pr'
            ? 'Magic link does not match this preview env.'
            : 'Invalid or revoked magic link.';
      res.end(body);
      return;
    }

    // ── Path 2: existing session cookie.
    const cookies = parseCookies(req.headers.cookie);
    const cookieValue = cookies[PREVIEW_SESSION_COOKIE];
    if (cookieValue) {
      const session = verifyPreviewSession(deps, cookieValue);
      if (session) {
        if (session.kind === 'magic_link' && session.pr_number !== prNumber) {
          // Scoped session, wrong PR — deny hard (do NOT re-redirect to
          // OAuth, the cookie is already present and we don't want to
          // pretend they're unauthenticated).
          res.statusCode = 403;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Forbidden: magic-link session does not match this preview env.');
          return;
        }
        // Valid session — pass through. Attach to req for downstream
        // handlers that want to log reviewer identity.
        (req as Request & { previewAuth?: PreviewSessionRow }).previewAuth = session;
        next();
        return;
      }
    }

    // ── Path 3: no session, no magic link → redirect to login.
    const state = generateOpaqueToken(d.randomBytes);
    const nextUrl = req.url;
    const nextHost = host ?? '';
    // State payload: `<state>|<encodedHost>|<encodedNextUrl>`. The host
    // is round-tripped so the callback — which runs on a *different*
    // sibling subdomain — can build an absolute Location back to the
    // originating PR env (e.g. `https://pr-42.preview.example.com<path>`).
    // Encoding the host in the signed payload also means we don't trust
    // a query param or Referer for the post-auth destination.
    const stateCookiePayload = encodeStatePayload({
      state,
      host: nextHost,
      nextUrl,
    });
    const signedStateCookie = signSessionCookie(stateCookiePayload, d.config.sessionSecret);
    res.setHeader(
      'Set-Cookie',
      serializeCookie(PREVIEW_STATE_COOKIE, signedStateCookie, {
        maxAgeSeconds: 600, // 10 minutes — just enough to complete OAuth
        httpOnly: true,
        secure: d.config.secureCookies,
        sameSite: 'Lax',
        // MUST span the middleware host + callback host. Without a
        // parent-domain cookie here, the callback 400s with "Missing
        // state cookie" — this is the cross-host scoping fix.
        domain: d.config.cookieDomain ?? undefined,
      }),
    );
    res.statusCode = 302;
    res.setHeader('Location', buildAuthorizeUrl(deps, { state }));
    res.end();
  };
}

// ─── State-cookie payload codec ───────────────────────────────────────────

/**
 * State cookie wire format (before HMAC):
 *   `<state>|<encodedHost>|<encodedNextUrl>`
 *
 * Three fields separated by `|`. Each user-controllable field is
 * `encodeURIComponent`-escaped so a literal `|` can't shift the parse.
 * Older two-field payloads (`state|nextUrl`) are still accepted by the
 * decoder for safety during a rolling deploy.
 */
export function encodeStatePayload(args: { state: string; host: string; nextUrl: string }): string {
  return `${args.state}|${encodeURIComponent(args.host)}|${encodeURIComponent(args.nextUrl)}`;
}

export interface DecodedStatePayload {
  state: string;
  host: string;
  nextUrl: string;
}

/** Parse a state cookie payload. Falls back to two-field when host is missing. */
export function decodeStatePayload(raw: string): DecodedStatePayload {
  const parts = raw.split('|');
  if (parts.length >= 3) {
    return {
      state: parts[0],
      host: decodeURIComponent(parts[1] ?? ''),
      nextUrl: decodeURIComponent(parts.slice(2).join('|') ?? ''),
    };
  }
  if (parts.length === 2) {
    // Legacy two-field format — no host, relative redirect only.
    return { state: parts[0], host: '', nextUrl: decodeURIComponent(parts[1] ?? '') };
  }
  return { state: raw, host: '', nextUrl: '' };
}

/**
 * Build the absolute post-callback destination from the stored host +
 * path. Only allows hosts matching `pr-<n>.<cookieDomainSuffix>` (or
 * bare `pr-<n>.*` when no cookieDomain configured — test case).
 * Everything else returns the fallback `/`.
 */
export function buildPostAuthRedirect(args: {
  host: string;
  nextUrl: string;
  cookieDomain: string | null;
  secure: boolean;
}): string {
  const { host, nextUrl, cookieDomain, secure } = args;
  const prNumber = extractPrNumberFromHost(host);
  if (prNumber === null) return '/';
  // When a cookieDomain is configured, require the host to end with it
  // (strip the leading dot for the endsWith check). This prevents a
  // forged state cookie from redirecting to an arbitrary host.
  if (cookieDomain) {
    const bare = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
    const lower = host.toLowerCase();
    const bareLower = bare.toLowerCase();
    if (lower !== bareLower && !lower.endsWith('.' + bareLower)) return '/';
  }
  const path = nextUrl && nextUrl.startsWith('/') ? nextUrl : '/';
  const scheme = secure ? 'https' : 'http';
  return `${scheme}://${host}${path}`;
}

// ─── Reaper (optional) ────────────────────────────────────────────────────

/**
 * Delete expired magic-link rows and session rows. Idempotent. Returns
 * the number of rows removed from each table — exposed for the cron job
 * and for heartbeat-style self-reporting.
 */
export function reapExpired(deps: PreviewAuthDeps): { magicLinks: number; sessions: number } {
  const d = resolve(deps);
  const cutoff = new Date(d.now()).toISOString();
  const mlk = d.db.prepare(`DELETE FROM preview_magic_links WHERE expires_at <= ?`).run(cutoff);
  const ses = d.db.prepare(`DELETE FROM preview_auth_sessions WHERE expires_at <= ?`).run(cutoff);
  return { magicLinks: mlk.changes, sessions: ses.changes };
}
