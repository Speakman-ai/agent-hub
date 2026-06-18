/**
 * Parse a date value into a Date object.
 * Handles: ISO strings, SQLite datetime strings (no TZ = UTC), epoch ms numbers.
 */
export function parseDate(val) {
  if (val == null || val === '') return null;
  if (val instanceof Date) return Number.isNaN(val.getTime()) ? null : val;
  if (typeof val === 'number') return new Date(val);
  const str = String(val);
  if (str.includes('T')) return new Date(str);
  return new Date(`${str}Z`);
}

/**
 * Format a date string as relative time ("2 min ago", "1h ago", etc.)
 */
export function relativeTime(dateStr) {
  const d = parseDate(dateStr);
  if (!d || Number.isNaN(d.getTime())) return '';
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
 * Compact absolute date ("Jun 18", or "Jun 18, 2025" for a prior year).
 * Mirrors `client/src/utils/time.js#shortDate` so the redesigned kanban card
 * shows the same created-date label on web and mobile. Returns '' for empty /
 * unparseable input.
 */
export function shortDate(dateStr) {
  const d = parseDate(dateStr);
  if (!d || Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const opts =
    d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' };
  return d.toLocaleDateString(undefined, opts);
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
 *
 * Mirrors `client/src/utils/time.js#relativeFuture` so web and mobile
 * render identical heartbeat / cron next-run badges.
 */
export function relativeFuture(dateStr) {
  const d = parseDate(dateStr);
  if (!d || Number.isNaN(d.getTime())) return { label: '', overdue: false };
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
 * Mirrors `client/src/utils/time.js#daysUntilPurge` so web + mobile render
 * identical "purges in N days" countdowns for archived sessions. Soft-deleted
 * sessions are hard-deleted `retentionDays` after `deletedAt` (default 7).
 * Returns `null` for unparseable input so callers can hide the chip.
 */
export function daysUntilPurge(deletedAt, retentionDays = 7) {
  const d = parseDate(deletedAt);
  if (!d || Number.isNaN(d.getTime())) return null;
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
    label = 'purges in <1h';
  } else {
    const hoursLeft = Math.ceil(remainingMs / msPerHour);
    label = `purges in ${hoursLeft}h`;
  }
  return { daysLeft, label };
}
