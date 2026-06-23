/**
 * Parse a date value into a Date object.
 * Handles: ISO strings, SQLite datetime strings (no TZ = UTC), epoch ms numbers.
 *
 * Exported because the server stores most timestamps as SQLite `datetime('now')`
 * strings (e.g. "2026-06-23 04:00:00") which carry no timezone marker. Passing
 * those straight to `new Date(str)` makes JS interpret them as *local* time, so
 * the rendered value is wrong by the viewer's UTC offset. Always route a server
 * timestamp through this (or the format* helpers below) rather than `new Date()`.
 */
export function parseDate(val: any): Date | null {
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
 * Format a server timestamp as an absolute local date+time string.
 * UTC-aware (via parseDate) and null-safe — returns '' for falsy/unparseable
 * input instead of the "Dec 31 1969" / "Invalid Date" that `new Date(null)`
 * or `new Date('bad')` would produce. Mirrors `Date.prototype.toLocaleString`.
 */
export function formatDateTime(val: any, opts?: Intl.DateTimeFormatOptions): string {
  const d = parseDate(val);
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, opts);
}

/**
 * Format a server timestamp as an absolute local date (no time).
 * UTC-aware and null-safe. Mirrors `Date.prototype.toLocaleDateString`.
 */
export function formatDate(val: any, opts?: Intl.DateTimeFormatOptions): string {
  const d = parseDate(val);
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, opts);
}

/**
 * Format a server timestamp as an absolute local time-of-day.
 * UTC-aware and null-safe. Mirrors `Date.prototype.toLocaleTimeString`.
 */
export function formatTime(val: any, opts?: Intl.DateTimeFormatOptions): string {
  const d = parseDate(val);
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, opts);
}

/**
 * Format a date string as relative time ("2 min ago", "1h ago", etc.)
 */
export function relativeTime(dateStr: any) {
  const d = parseDate(dateStr);
  if (!d || isNaN(d.getTime())) return '';
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
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
 * Compact absolute date label for dense card UIs.
 *   - Same calendar year as today → "Jun 18"
 *   - Different year → "Jun 18, 2025"
 * Returns '' for falsy / unparseable input.
 */
export function shortDate(dateStr: any) {
  const d = parseDate(dateStr);
  if (!d || isNaN(d.getTime())) return '';
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' };
  return d.toLocaleDateString(undefined, opts);
}

/**
 * Format elapsed seconds as "Xm Ys"
 */
export function formatElapsed(seconds: any) {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}m ${sec}s`;
}

/**
 * Format a future date string as "in Xm" / "in 2h" etc.
 * Returns { label, overdue } where overdue=true means the date is in the past.
 */
export function relativeFuture(dateStr: any) {
  const d = parseDate(dateStr);
  if (!d || isNaN(d.getTime())) return { label: '', overdue: false };
  const diffMs = d.getTime() - new Date().getTime();
  const overdue = diffMs < 0;
  const absSec = Math.floor(Math.abs(diffMs) / 1000);
  const absMin = Math.floor(absSec / 60);
  const absHr = Math.floor(absMin / 60);
  const absDay = Math.floor(absHr / 24);

  let magnitude: any;
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
export function daysUntilPurge(deletedAt: any, retentionDays: any = 7) {
  if (!deletedAt) return null;
  const d = parseDate(deletedAt);
  if (!d || isNaN(d.getTime())) return null;
  const msPerDay = 1000 * 60 * 60 * 24;
  const msPerHour = 1000 * 60 * 60;
  const ageMs = Date.now() - d.getTime();
  const remainingMs = retentionDays * msPerDay - ageMs;
  const daysLeft = Math.max(0, Math.ceil(remainingMs / msPerDay));
  let label: any;
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
