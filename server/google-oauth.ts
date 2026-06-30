/**
 * google-oauth.ts — pure helpers for the Google OAuth 2.0 Authorization Code
 * flow (web-server flow). Token exchange, the per-user connection store, and
 * the callback handler are owned by the connection-management ticket; this
 * module currently provides the authorize-URL builder used by
 * `/api/auth/google/start`.
 *
 * Refs:
 *   https://developers.google.com/identity/protocols/oauth2/web-server
 *   https://developers.google.com/identity/protocols/oauth2/scopes
 */

import type { GoogleOAuthConfig } from './types.js';

/** Google's OAuth 2.0 authorization endpoint. */
export const GOOGLE_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/** Google's OAuth 2.0 token endpoint (code exchange + refresh). */
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Google's OAuth 2.0 token revocation endpoint (used on disconnect). */
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/**
 * OpenID Connect UserInfo endpoint. Called immediately after a code exchange
 * with the fresh access token so we can persist the linked account's stable
 * `sub` + `email` alongside the tokens. Requires the `openid`/`email` scopes,
 * which {@link GOOGLE_IDENTITY_SCOPES} always requests.
 *
 * Ref: https://developers.google.com/identity/openid-connect/openid-connect#an-id-tokens-payload
 */
export const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

/**
 * The OAuth callback path. The full redirect URI (this path appended to the
 * resolved public base) is what must be registered as an *authorized redirect
 * URI* on the Google OAuth client, and it is what `/start` sends to Google.
 */
export const GOOGLE_CALLBACK_PATH = '/api/auth/google/callback';

/**
 * Resolve the canonical Google OAuth redirect URI the way the server actually
 * sends it to Google, so the admin can register the exact same value in the
 * Google Cloud Console (a mismatch fails consent with `redirect_uri_mismatch`).
 *
 * Precedence mirrors the rest of the OAuth stack: prefer the configured
 * `publicUrl` (stable behind nginx, may carry a path prefix), falling back to
 * the incoming request's origin for local dev where `publicUrl` is null. Never
 * reconstruct this from the browser `window.location.origin`, which can diverge
 * from `publicUrl`.
 */
export function resolveGoogleRedirectUri(opts: {
  publicUrl?: string | null;
  requestOrigin?: string | null;
}): string {
  const base = (opts.publicUrl || opts.requestOrigin || '').replace(/\/+$/, '');
  return `${base}${GOOGLE_CALLBACK_PATH}`;
}

/**
 * Baseline identity scopes always requested so the callback can resolve the
 * linked Google account (`sub` + email). Surface scopes (Calendar, Gmail,
 * Sheets) are requested incrementally on top of these per the epic's
 * sensitive-scope tiering. `openid email profile` are non-sensitive.
 */
export const GOOGLE_IDENTITY_SCOPES: readonly string[] = ['openid', 'email', 'profile'];

/**
 * Build the Google OAuth authorize URL.
 *
 * `access_type=offline` + `prompt=consent` guarantee a refresh_token on every
 * grant (Google only returns one on first consent unless re-prompted), matching
 * the epic AUTH decision. `include_granted_scopes=true` enables incremental
 * authorization so previously granted scopes survive a per-surface re-consent.
 */
export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  /**
   * Scopes to request. Omit to use {@link GOOGLE_IDENTITY_SCOPES}; the
   * identity scopes are always merged in so the callback can always resolve
   * the account, even on a surface-only re-consent.
   */
  scopes?: readonly string[];
  /** Optional `login_hint` to pre-fill the account chooser. */
  loginHint?: string;
}): string {
  const requested = opts.scopes && opts.scopes.length > 0 ? opts.scopes : GOOGLE_IDENTITY_SCOPES;
  const merged = Array.from(
    new Set(
      [...GOOGLE_IDENTITY_SCOPES, ...requested].map((s) => s.trim()).filter((s) => s.length > 0),
    ),
  );
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: merged.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: opts.state,
  });
  if (opts.loginHint) params.set('login_hint', opts.loginHint);
  return `${GOOGLE_AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

/**
 * The server-global Google OAuth *app* credentials (client id/secret). Aliased
 * to {@link GoogleOAuthConfig} so the connection store can take the same shape
 * the admin config already resolves (`config.googleOAuth`).
 */
export type GoogleOAuthCredentials = GoogleOAuthConfig;

/**
 * Shape of a successful Google token-refresh response. Unlike GitHub, Google
 * does NOT rotate the refresh_token on a normal refresh — the response carries
 * a new `access_token` + `expires_in` only, and the original refresh_token
 * stays valid. `scope` echoes the granted scopes; `id_token` is present only
 * when `openid` was in the original grant.
 *
 * Ref: https://developers.google.com/identity/protocols/oauth2/web-server#offline
 */
export interface GoogleRefreshedTokens {
  access_token: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

/**
 * Thrown when Google rejects a refresh with `invalid_grant` — the refresh token
 * has been revoked (user un-linked the app, password change, 6-month inactivity,
 * or too many outstanding tokens). The connection is dead and the caller MUST
 * clear the stored row so the UI prompts for a re-link.
 *
 * Ref: https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke
 */
export class GoogleInvalidGrantError extends Error {
  constructor(public readonly description?: string) {
    super(`Google OAuth refresh rejected: invalid_grant${description ? ` (${description})` : ''}`);
    this.name = 'GoogleInvalidGrantError';
  }
}

/**
 * Refresh an expiring/expired Google user access token using its refresh_token.
 *
 * The refresh_token is long-lived and reusable — Google returns a new
 * access_token + expires_in but no new refresh_token, so callers persist the
 * rotated access token and keep the existing refresh token in place.
 *
 * Throws {@link GoogleInvalidGrantError} when Google responds `invalid_grant`
 * (revoked token → dead connection); throws a generic Error on any other
 * failure (transient network / 5xx → connection still alive, retry later).
 */
export async function refreshGoogleAccessToken(opts: {
  credentials: GoogleOAuthCredentials;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<GoogleRefreshedTokens> {
  const f = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: opts.credentials.clientId,
    client_secret: opts.credentials.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
  });
  const res = await f(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    // Parse the error body to distinguish a revoked grant (terminal) from a
    // transient failure (retryable). Google sends `{error, error_description}`.
    let parsed: { error?: string; error_description?: string } = {};
    try {
      parsed = (await res.json()) as typeof parsed;
    } catch {
      // Non-JSON error body — fall through to the generic throw below.
    }
    if (parsed.error === 'invalid_grant') {
      throw new GoogleInvalidGrantError(parsed.error_description);
    }
    const detail = parsed.error_description || parsed.error || (await res.text().catch(() => ''));
    throw new Error(`Google OAuth refresh failed (${res.status}): ${detail}`);
  }
  const json = (await res.json()) as Partial<GoogleRefreshedTokens> & { error?: string };
  if (json.error === 'invalid_grant') {
    throw new GoogleInvalidGrantError();
  }
  if (!json.access_token || typeof json.expires_in !== 'number') {
    throw new Error('Google OAuth refresh response missing access_token/expires_in');
  }
  return json as GoogleRefreshedTokens;
}

/**
 * Shape of a successful authorization-code exchange. `refresh_token` is present
 * because `/start` requests `access_type=offline` + `prompt=consent`; it is
 * still typed optional because Google omits it on a re-consent that grants no
 * new scopes (incremental auth). `scope` echoes the space-delimited granted
 * scopes. `id_token` is present because `openid` is always requested.
 *
 * Ref: https://developers.google.com/identity/protocols/oauth2/web-server#exchange-authorization-code
 */
export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

/** The linked Google account, as resolved from the UserInfo endpoint. */
export interface GoogleUserInfo {
  /** Stable, never-reassigned account identifier. The canonical account key. */
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string | null;
  picture?: string | null;
}

/**
 * Exchange an authorization code (delivered to our callback as `?code=...`) for
 * an access token + refresh token. Throws on any non-2xx or `error` body; the
 * callback surfaces that as a 502 status page.
 */
export async function exchangeCodeForGoogleTokens(opts: {
  credentials: GoogleOAuthCredentials;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<GoogleTokenResponse> {
  const f = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: opts.credentials.clientId,
    client_secret: opts.credentials.clientSecret,
    code: opts.code,
    grant_type: 'authorization_code',
    redirect_uri: opts.redirectUri,
  });
  const res = await f(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    // Read the body once, then parse the captured text — a Response body is a
    // one-shot stream, so calling res.json() then res.text() would double-read.
    const rawBody = await res.text().catch(() => '');
    let parsed: { error?: string; error_description?: string } = {};
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      // Non-JSON error body — fall back to the raw text below.
    }
    const detail = parsed.error_description || parsed.error || rawBody;
    throw new Error(`Google OAuth token exchange failed (${res.status}): ${detail}`);
  }
  const json = (await res.json()) as Partial<GoogleTokenResponse> & {
    error?: string;
    error_description?: string;
  };
  if (json.error) {
    throw new Error(`Google OAuth error: ${json.error_description || json.error}`);
  }
  if (!json.access_token || typeof json.expires_in !== 'number') {
    throw new Error('Google OAuth token response missing access_token/expires_in');
  }
  return json as GoogleTokenResponse;
}

/**
 * Resolve the linked account's stable `sub` + email from the OIDC UserInfo
 * endpoint using a freshly-issued access token. Called right after the code
 * exchange so the connection row records *which* Google account is linked.
 */
export async function fetchGoogleUserInfo(opts: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<GoogleUserInfo> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(GOOGLE_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${opts.accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google userinfo fetch failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as Partial<GoogleUserInfo>;
  if (typeof json.sub !== 'string' || !json.sub) {
    throw new Error('Google userinfo response missing sub');
  }
  return {
    sub: json.sub,
    email: typeof json.email === 'string' ? json.email : '',
    email_verified: json.email_verified,
    name: json.name ?? null,
    picture: json.picture ?? null,
  };
}

/**
 * Best-effort revocation of a Google token (access or refresh) at the revoke
 * endpoint. Used on disconnect so the grant is dropped on Google's side, not
 * just locally. Never throws — a failed revoke (already-revoked token, network
 * blip) must not block clearing the local row.
 */
export async function revokeGoogleToken(opts: {
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(GOOGLE_REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: opts.token }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}
