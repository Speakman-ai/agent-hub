/**
 * Pure helpers for the Security screen, kept out of the RN-importing screen
 * module so vitest (node env) can unit-test them. Mirrors the web client's
 * SecurityPage helpers.
 */

// Severity → sort rank (most urgent first). Matches the server's ORDER BY.
export const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };

/** Sort findings most-urgent first, then most-recently-seen within a severity. */
export function sortFindings(list) {
  return [...list].sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity] ?? 5;
    const sb = SEVERITY_RANK[b.severity] ?? 5;
    if (sa !== sb) return sa - sb;
    return (b.last_seen_at || 0) - (a.last_seen_at || 0);
  });
}

/** Sum of open critical + high counts — the sidebar/drawer badge value. */
export function openCriticalHigh(openCounts) {
  if (!openCounts) return 0;
  return (openCounts.critical || 0) + (openCounts.high || 0);
}
