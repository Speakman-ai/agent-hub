/**
 * Machine-readable codes that mark a response as "this caller's session is
 * dead" — meaning the client should drop its stored token and re-authenticate.
 *
 * A bare status code is not enough to make that call. `401` is routinely used
 * for "an upstream integration is not connected" (e.g. no GitHub OAuth token),
 * which says nothing about the caller's own credentials; treating those as a
 * dead session logs the user out of a perfectly valid session. Responses must
 * therefore opt in by carrying one of these codes.
 *
 * Server and client are versioned together. A server that omits the code on a
 * genuine session failure leaves the client holding a dead token with no
 * automatic recovery, so every session-failure branch in `authMiddleware` must
 * set one.
 */

/** Credentials were missing, malformed, expired, or no longer map to a user. */
export const AUTH_CODE_INVALID_SESSION = 'invalid_session';

/** Credentials verified, but the holder has no membership in the active org. */
export const AUTH_CODE_NO_ACTIVE_ORG_MEMBERSHIP = 'no_active_org_membership';

/** Caller is authenticated; the GitHub integration they need is not connected. */
export const AUTH_CODE_GITHUB_NOT_CONNECTED = 'github_not_connected';

/**
 * Status returned when an authenticated caller hits a route that requires a
 * GitHub connection they do not have. Deliberately not `401`/`403`: the caller
 * is authenticated and permitted, but a precondition on their account is unmet.
 */
export const GITHUB_NOT_CONNECTED_STATUS = 412;

/**
 * True when a failed response means the caller's session is dead and the
 * client should clear its token and bounce to login.
 */
export function isDeadSessionResponse(status: number, code: string | null | undefined): boolean {
  if (status === 401) return code === AUTH_CODE_INVALID_SESSION;
  if (status === 403) return code === AUTH_CODE_NO_ACTIVE_ORG_MEMBERSHIP;
  return false;
}
