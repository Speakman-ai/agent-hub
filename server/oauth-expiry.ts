/**
 * Claude OAuth credential files sometimes store `expiresAt` as Unix seconds (JWT-style)
 * and sometimes as epoch milliseconds. Compare consistently against `Date.now()`.
 */
export const OAUTH_EXPIRES_AT_MS_THRESHOLD = 1e12;

export function normalizeOAuthExpiresAtMs(expiresAt: number): number {
  if (!Number.isFinite(expiresAt)) return expiresAt;
  return expiresAt < OAUTH_EXPIRES_AT_MS_THRESHOLD ? expiresAt * 1000 : expiresAt;
}

/**
 * Per-user Claude credentials are stored as `string | null` in the users table
 * (`claude_code_oauth_expires_at`). Callers may PUT either an ISO-8601 string,
 * a numeric string in Unix seconds (the JWT-style shape that PR #723 fixed on
 * the host-config path), or a numeric string in epoch milliseconds. This helper
 * normalises any of those representations into a single `{ expiresAtMs, iso,
 * expired }` shape so the route layer never has to recompute the seconds-vs-ms
 * threshold itself, and so the UI can rely on a server-computed `expired`
 * boolean instead of doing its own `Date.now() > expiresAt` comparison against
 * a possibly un-normalised value.
 *
 * - Empty / null / unparseable input → `null` (caller treats as "no expiry").
 * - Numeric input (string or number) routes through `normalizeOAuthExpiresAtMs`
 *   so a sub-threshold value is multiplied to ms.
 * - ISO-8601 input is parsed with `Date.parse` and the resulting ms timestamp
 *   is returned verbatim (no rescaling — `Date.parse` already returns ms).
 *
 * Comparisons against `Date.now()` use a fresh read each call so callers get a
 * consistent answer no matter how stale a cached value might be.
 */
export interface ClaudeOAuthExpiry {
  expiresAtMs: number;
  iso: string;
  expired: boolean;
}

export function parseClaudeOAuthExpiry(
  raw: string | number | null | undefined,
): ClaudeOAuthExpiry | null {
  if (raw == null) return null;

  let expiresAtMs: number | null = null;

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    expiresAtMs = normalizeOAuthExpiresAtMs(raw);
  } else {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // A pure numeric string is treated as Unix seconds or ms based on the
    // same threshold the host-config path uses. Anything else (ISO 8601,
    // RFC 2822, etc.) goes through `Date.parse`.
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return null;
      expiresAtMs = normalizeOAuthExpiresAtMs(n);
    } else {
      const parsed = Date.parse(trimmed);
      if (!Number.isFinite(parsed)) return null;
      expiresAtMs = parsed;
    }
  }

  if (expiresAtMs == null || !Number.isFinite(expiresAtMs)) return null;
  return {
    expiresAtMs,
    iso: new Date(expiresAtMs).toISOString(),
    expired: Date.now() > expiresAtMs,
  };
}
