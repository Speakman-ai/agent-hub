/**
 * Native OAuth sign-in helpers. No expo imports so tests run under plain Vitest.
 */

/**
 * App URL scheme registered for OAuth deep-link returns. MUST match
 * `expo.scheme` in `mobile/app.json` and the server allowlist in
 * `server/oauth-return-to.ts` (`MOBILE_OAUTH_SCHEMES`). If any of the three
 * drift, the in-app browser never hands control back to the app.
 */
export const OAUTH_SCHEME = 'agenthub';

/** Deep-link path the OAuth callback redirects to (scheme://<path>). */
export const OAUTH_REDIRECT_PATH = 'oauth-callback';

/** Shape of the `WebBrowser.openAuthSessionAsync` result we care about. */
export interface AuthSessionResultLike {
  type: 'success' | 'cancel' | 'dismiss' | 'locked' | string;
  url?: string;
}

export interface OAuthOutcome {
  /** The redirect completed and the browser handed control back. */
  ok: boolean;
  /** The user cancelled or dismissed the browser (not an error). */
  cancelled: boolean;
}

/**
 * Classify the native auth-session result into a small, UI-friendly shape.
 * `success` means the callback redirected to our deep link; `cancel` /
 * `dismiss` are benign user aborts; anything else is treated as a failure.
 */
export function interpretAuthSessionResult(result: AuthSessionResultLike): OAuthOutcome {
  if (result.type === 'success') {
    return { ok: true, cancelled: false };
  }
  if (result.type === 'cancel' || result.type === 'dismiss') {
    return { ok: false, cancelled: true };
  }
  return { ok: false, cancelled: false };
}
