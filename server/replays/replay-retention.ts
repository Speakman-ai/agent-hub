/**
 * replay-retention.ts — pure retention-window math for the two-tier replay
 * retention model (Datadog parity).
 *
 * Two tiers:
 *   - **Default tier** — the session/event index + hot blobs live for
 *     `replayRetentionDays` (global config, per-tenant overridable). The
 *     retention sweeper (`replay-retention-sweeper.ts`) expires anything older.
 *   - **Extended tier** — an operator can FLAG an individual session for
 *     extended retention (up to 15 months). Flagging stamps a `retained_until`
 *     instant onto the row; the sweeper skips any row whose `retained_until` is
 *     still in the future, so a flagged session is exempt from the default
 *     expiry until its extension lapses.
 *
 * The 15-month clock starts WHEN THE EXTENSION IS ENABLED, not at capture — a
 * three-week-old session flagged today is retained for 15 months from today.
 * That "clock starts at enable" rule is why flagging persists an absolute
 * `retained_until` rather than a relative "keep for N months" flag.
 *
 * Pure (no DB, no Express, injectable clock) so the clamp / window math is
 * unit-testable in isolation and used by the flag route
 * (`POST /api/replays/:id/retention`).
 */

/**
 * Format an epoch-ms instant as the SQLite `datetime('now')` text format
 * (`YYYY-MM-DD HH:MM:SS`, UTC) so a string `<` comparison against the stored
 * `created_at` / `retained_until` columns collates correctly. SQLite stores
 * these as UTC text with no timezone suffix; ISO's `T`/`Z`/millis would not
 * collate against that. Lives here (the pure module) and is re-exported from the
 * sweeper for back-compat.
 */
export function toSqliteUtc(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ');
}

/** Datadog's extended-retention ceiling: 15 months. */
export const MAX_EXTENDED_RETENTION_MONTHS = 15;
/** Floor: extending for zero months is meaningless — the minimum window is 1. */
export const MIN_EXTENDED_RETENTION_MONTHS = 1;
/** Default extension window when a tenant hasn't configured one: the full 15. */
export const DEFAULT_EXTENDED_RETENTION_MONTHS = 15;

/**
 * Clamp an arbitrary value to a valid extended-retention window in whole months
 * within [1, 15]. Non-finite / unset / non-positive resolves to the full 15
 * (the safe "keep it as long as allowed" default); fractional months floor.
 */
export function clampExtendedRetentionMonths(value: number | undefined | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_EXTENDED_RETENTION_MONTHS;
  }
  const whole = Math.floor(value);
  if (whole < MIN_EXTENDED_RETENTION_MONTHS) return MIN_EXTENDED_RETENTION_MONTHS;
  if (whole > MAX_EXTENDED_RETENTION_MONTHS) return MAX_EXTENDED_RETENTION_MONTHS;
  return whole;
}

/**
 * Add whole calendar months to an epoch-ms instant in UTC, clamping a
 * day-of-month overflow to the last day of the target month (Jan 31 + 1 month →
 * Feb 28/29) so the result is always a real date. Pure — the caller supplies the
 * instant, no ambient clock.
 */
export function addMonthsUtc(epochMs: number, months: number): number {
  const d = new Date(epochMs);
  const targetMonthIndex = d.getUTCMonth() + months;
  const targetYear = d.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
  const day = d.getUTCDate();
  // Last day of the target month: day 0 of the following month.
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);
  return Date.UTC(
    targetYear,
    normalizedMonth,
    clampedDay,
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

/**
 * Compute the absolute `retained_until` instant for a session flagged for
 * extended retention: `enabledAt + clamp(months)`, in epoch ms. The clock
 * starts at `enabledAtMs` (enable time), which is the whole point of the
 * two-tier model — a capture flagged long after ingest is still kept for the
 * full window from the flag.
 */
export function computeRetainedUntil(
  enabledAtMs: number,
  months: number | undefined | null,
): number {
  return addMonthsUtc(enabledAtMs, clampExtendedRetentionMonths(months));
}
