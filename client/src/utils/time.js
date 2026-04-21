/**
 * Parse a date value into a Date object.
 * Handles: ISO strings, SQLite datetime strings (no TZ = UTC), epoch ms numbers.
 */
function parseDate(val) {
  if (!val) return null;
  // Numeric timestamp (epoch ms)
  if (typeof val === 'number') return new Date(val);
  const str = String(val);
  // If it contains 'T', it's ISO format — Date constructor handles it
  if (str.includes('T')) return new Date(str);
  // SQLite datetime format (no timezone) — treat as UTC
  return new Date(str + 'Z');
}

/**
 * Format a date string as relative time ("2 min ago", "1h ago", etc.)
 */
export function relativeTime(dateStr) {
  const d = parseDate(dateStr);
  if (!d || isNaN(d)) return '';
  const now = new Date();
  const diffMs = now - d;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

/**
 * Format elapsed seconds as "Xm Ys"
 */
export function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}m ${sec}s`;
}

/**
 * Format a future date string as "in Xm" / "in 2h" etc.
 * Returns { label, overdue } where overdue=true means the date is in the past.
 */
export function relativeFuture(dateStr) {
  const d = parseDate(dateStr);
  if (!d || isNaN(d)) return { label: '', overdue: false };
  const diffMs = d - new Date();
  const overdue = diffMs < 0;
  const absSec = Math.floor(Math.abs(diffMs) / 1000);
  const absMin = Math.floor(absSec / 60);
  const absHr = Math.floor(absMin / 60);
  const absDay = Math.floor(absHr / 24);

  let magnitude;
  if (absSec < 60) magnitude = `${absSec}s`;
  else if (absMin < 60) magnitude = `${absMin}m`;
  else if (absHr < 24) magnitude = `${absHr}h`;
  else magnitude = `${absDay}d`;

  return {
    label: overdue ? `overdue ${magnitude}` : `in ${magnitude}`,
    overdue,
  };
}

/**
 * Compute how long until a soft-deleted row is purged.
 *
 * Server-side rows carry `deleted_at` (ISO or SQLite datetime). Soft-deleted
 * sessions are hard-deleted `retentionDays` after that timestamp. This helper
 * returns a short human label plus the raw `daysLeft` integer so the caller
 * can colour-code urgency (e.g. red when <= 1).
 *
 * Returns `null` when `deletedAt` is falsy or unparseable — callers should
 * hide the countdown chip in that case.
 */
export function daysUntilPurge(deletedAt, retentionDays = 7) {
  if (!deletedAt) return null;
  const d = parseDate(deletedAt);
  if (!d || isNaN(d)) return null;
  const msPerDay = 1000 * 60 * 60 * 24;
  const msPerHour = 1000 * 60 * 60;
  const ageMs = Date.now() - d.getTime();
  const remainingMs = retentionDays * msPerDay - ageMs;
  const daysLeft = Math.max(0, Math.ceil(remainingMs / msPerDay));
  let label;
  if (remainingMs <= 0) {
    label = 'purging…';
  } else if (remainingMs >= msPerDay) {
    label = `purges in ${daysLeft}d`;
  } else if (remainingMs < msPerHour) {
    // Less than a full hour — collapse into "<1h" rather than flashing "1h"
    // for a whole 60-minute window.
    label = 'purges in <1h';
  } else {
    // Sub-day — surface hours so users can tell "22h left" apart from
    // "2h left" before permanent purge.
    const hoursLeft = Math.ceil(remainingMs / msPerHour);
    label = `purges in ${hoursLeft}h`;
  }
  return { daysLeft, label };
}
