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

/** Google's OAuth 2.0 authorization endpoint. */
export const GOOGLE_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

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
