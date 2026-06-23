/**
 * Pure helpers for the Security screen, kept out of the RN-importing screen
 * module so vitest (node env) can unit-test them. Mirrors the web client's
 * SecurityPage helpers.
 */
// Severity → sort rank (most urgent first). Matches the server's ORDER BY.
export const SEVERITY_RANK: Record<string, any> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
/** Sort findings most-urgent first, then most-recently-seen within a severity. */
export function sortFindings(list: any) {
    return [...list].sort((a: any, b: any) => {
        const sa = SEVERITY_RANK[a.severity] ?? 5;
        const sb = SEVERITY_RANK[b.severity] ?? 5;
        if (sa !== sb)
            return sa - sb;
        return (b.last_seen_at || 0) - (a.last_seen_at || 0);
    });
}
/** Sum of open critical + high counts — the sidebar/drawer badge value. */
export function openCriticalHigh(openCounts: any) {
    if (!openCounts)
        return 0;
    return (openCounts.critical || 0) + (openCounts.high || 0);
}
/**
 * Tally findings into per-severity buckets plus an `all` total. Counts the
 * currently-loaded list, so it tracks the active status filter rather than the
 * always-open server `openCounts`. Unrecognised severities fall into `unknown`.
 */
export function countBySeverity(list: any): Record<string, any> {
    const counts: Record<string, any> = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, all: 0 };
    if (!Array.isArray(list))
        return counts;
    for (const f of list) {
        counts.all += 1;
        if (counts[f?.severity] === undefined)
            counts.unknown += 1;
        else
            counts[f.severity] += 1;
    }
    return counts;
}
