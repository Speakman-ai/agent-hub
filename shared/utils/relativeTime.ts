/**
 * Relative-time formatting shared by the Infrastructure panels.
 *
 * Extracted from `infraSpend.ts`, where it started as a private helper, once the
 * quota headroom panel needed the same phrasing. Two copies would drift, and the
 * one place they must not drift is exactly this: both panels sit on the same tab
 * and an operator reading "3m ago" on one and "3 minutes ago" on the other would
 * reasonably wonder whether they mean different things.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Render an age as a short "how long ago" string.
 *
 * Sub-minute ages collapse to "just now" rather than counting seconds: a panel
 * that polls once a minute cannot honestly claim second-level precision, and a
 * ticking seconds counter invites the reader to treat it as live.
 */
export function formatAgo(deltaMs: number): string {
  // A negative delta is clock skew between the server's timestamp and the
  // device's clock, not a cache from the future.
  if (!Number.isFinite(deltaMs) || deltaMs < MINUTE) return 'just now';
  if (deltaMs < HOUR) return `${Math.floor(deltaMs / MINUTE)}m ago`;
  if (deltaMs < 2 * DAY) return `${Math.floor(deltaMs / HOUR)}h ago`;
  return `${Math.floor(deltaMs / DAY)}d ago`;
}
