/**
 * oauth-return-to.ts — shared allowlist for OAuth `returnTo` targets.
 *
 * The personal OAuth flows ("Sign in with GitHub", etc.) round-trip a
 * `returnTo` through a signed state JWT so the callback can send the user
 * back where they started. Two callers, two shapes:
 *
 *   - **Web / Electron**: a same-origin relative path (`/settings?tab=git`).
 *     Anything absolute or protocol-relative (`//evil.com`) is an
 *     open-redirect vector and must be rejected.
 *   - **React Native (expo-auth-session)**: a custom deep-link scheme
 *     (`agenthub://oauth-callback`). `WebBrowser.openAuthSessionAsync`
 *     watches for a redirect to this URL to close the in-app browser and
 *     hand control back to the app. The scheme must match the one declared
 *     in `mobile/app.json` (`expo.scheme`).
 *
 * Allowing arbitrary schemes would reintroduce the open-redirect hole, so
 * the mobile side is gated to a fixed allowlist of app schemes.
 */

/**
 * Custom URL schemes the mobile app registers for OAuth deep-link returns.
 * MUST stay in sync with `expo.scheme` in `mobile/app.json`. Lowercase —
 * URL schemes are case-insensitive and we normalize before comparing.
 */
export const MOBILE_OAUTH_SCHEMES = ['agenthub'] as const;

/** RFC-3986 scheme grammar: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ). */
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Validate and normalize a raw `returnTo` value from a query string.
 *
 * @returns the value to persist in the state JWT, or `undefined` when the
 *   input is missing or fails the allowlist. `undefined` means "no
 *   returnTo" — callers fall back to `/`.
 */
export function sanitizeOAuthReturnTo(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;

  // Web / Electron: same-origin relative path only. Reject protocol-relative
  // (`//host`) which browsers treat as absolute to another origin.
  if (raw.startsWith('/')) {
    return raw.startsWith('//') ? undefined : raw;
  }

  // Mobile: custom deep-link scheme, gated to the app's declared schemes.
  const match = SCHEME_RE.exec(raw);
  if (match) {
    const scheme = match[1].toLowerCase();
    if ((MOBILE_OAUTH_SCHEMES as readonly string[]).includes(scheme)) {
      return raw;
    }
  }

  return undefined;
}

/** True when the sanitized value is a mobile deep-link (custom scheme). */
export function isMobileOAuthReturnTo(value: string): boolean {
  const match = SCHEME_RE.exec(value);
  if (!match) return false;
  return (MOBILE_OAUTH_SCHEMES as readonly string[]).includes(match[1].toLowerCase());
}
