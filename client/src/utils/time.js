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
