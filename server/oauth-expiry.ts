/**
 * Claude OAuth credential files sometimes store `expiresAt` as Unix seconds (JWT-style)
 * and sometimes as epoch milliseconds. Compare consistently against `Date.now()`.
 */
export const OAUTH_EXPIRES_AT_MS_THRESHOLD = 1e12;

export function normalizeOAuthExpiresAtMs(expiresAt: number): number {
  if (!Number.isFinite(expiresAt)) return expiresAt;
  return expiresAt < OAUTH_EXPIRES_AT_MS_THRESHOLD ? expiresAt * 1000 : expiresAt;
}
