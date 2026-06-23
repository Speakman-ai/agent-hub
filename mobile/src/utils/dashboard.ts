/**
 * Pure helpers for the mobile DashboardScreen.
 *
 * The screen itself is a thin RN view over these — keeping the data
 * shaping in plain JS means we can unit-test the mobile dashboard via
 * `vitest` (which only runs `src/utils/`) without booting the RN
 * environment.
 */
import { parseNativePrUrl } from './prFormatting';
import { colors } from '../theme/colors';
export const HEADLINE_TILES = [
    { key: 'projects', label: 'Projects' },
    { key: 'agents', label: 'Agents' },
    { key: 'sessions', label: 'Sessions' },
    { key: 'activeSessions', label: 'Active sessions' },
    { key: 'openCards', label: 'Open cards' },
    { key: 'openPRs', label: 'Open PRs' },
    { key: 'escalations', label: 'Escalations' },
];
export const PRIORITY_KEYS = ['urgent', 'high', 'medium', 'low'];
export const ACTIVITY_LABELS: Record<string, any> = {
    card_created: 'Card created',
    card_updated: 'Card updated',
    session_created: 'Session started',
    escalation: 'Escalation',
    pr_created: 'PR opened',
};
/**
 * Map the dashboard headline payload to a list of `{ key, label, value }`
 * tuples in the canonical display order. Missing keys default to 0 so the
 * UI never renders `undefined`.
 */
export function formatHeadlineTiles(headline: any = {}) {
    return HEADLINE_TILES.map(({ key, label }: any) => ({
        key,
        label,
        value: Number(headline?.[key] ?? 0),
    }));
}
/**
 * Convert the priority bucket map to a list of `{ key, count, percent }`
 * rows in canonical priority order. `percent` is the row's share of the
 * largest bucket, scaled 0..100, so the screen can render proportional
 * bars without recomputing the max each frame.
 */
export function priorityRows(byPriority: any = {}) {
    const max = Math.max(1, ...PRIORITY_KEYS.map((k: any) => Number(byPriority?.[k] ?? 0)));
    return PRIORITY_KEYS.map((key: any) => {
        const count = Number(byPriority?.[key] ?? 0);
        return {
            key,
            count,
            percent: Math.round((count / max) * 100),
        };
    });
}
/**
 * Same idea as `priorityRows` but for `kanban.byColumn`. Preserves the
 * server's column ordering and tags each row with its scaled `percent`.
 */
export function columnRows(byColumn: any = []) {
    const max = Math.max(1, ...byColumn.map((c: any) => Number(c?.count ?? 0)));
    return byColumn.map((row: any) => ({
        columnName: row.columnName,
        count: Number(row.count ?? 0),
        percent: Math.round((Number(row.count ?? 0) / max) * 100),
    }));
}
/** Look up a human label for an activity event type. */
export function activityLabel(type: any) {
    return ACTIVITY_LABELS[type] || 'Activity';
}
/**
 * Canonical activity type keys in display order. The web and mobile
 * dashboards both render filter chips against this list so a newly-
 * arriving event type still has a chip after a live refetch.
 */
export const ACTIVITY_TYPE_KEYS = [
    'card_created',
    'card_updated',
    'session_created',
    'escalation',
    'pr_created',
];
/**
 * Narrow an activity list to only the types in `activeTypes`.
 *
 * Empty / nullish `activeTypes` means "All" — no narrowing. An invalid
 * input `items` returns `[]` so callers don't have to defend against
 * `null` payloads from a half-loaded dashboard.
 */
export function filterActivity(items: any, activeTypes: any) {
    if (!Array.isArray(items))
        return [];
    if (!activeTypes)
        return items;
    const set = activeTypes instanceof Set
        ? activeTypes
        : Array.isArray(activeTypes)
            ? new Set(activeTypes)
            : null;
    if (!set || set.size === 0)
        return items;
    return items.filter((it: any) => set.has(it?.type));
}
/**
 * Count activity items grouped by `type`. Returns an object keyed by
 * type with numeric counts. Items with no `type` are ignored.
 */
export function countByType(items: any) {
    const counts: Record<string, any> = {};
    if (!Array.isArray(items))
        return counts;
    for (const it of items) {
        const t = it?.type;
        if (!t)
            continue;
        counts[t] = (counts[t] || 0) + 1;
    }
    return counts;
}
export const PR_PRIORITY_DOT: Record<string, any> = {
    urgent: colors.rose400,
    high: '#FB923C',
    medium: colors.amber400,
    low: colors.emerald400,
};
const SUPPORT_SEVERITY_RANK: Record<string, any> = { critical: 0, high: 1, medium: 2, low: 3 };
export const SUPPORT_SEVERITY_DOT: Record<string, any> = {
    critical: colors.red500,
    high: '#FB923C',
    medium: colors.amber400,
    low: colors.gray500,
};
export const SUPPORT_STATUS_FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'new', label: 'New' },
    { key: 'investigating', label: 'Investigating' },
];
/** Severity-first, newest-within-severity. Mirrors web `DashboardView`. */
export function sortSupportBySeverity(list: any) {
    return [...list].sort((a: any, b: any) => {
        const sa = SUPPORT_SEVERITY_RANK[a.severity] ?? 4;
        const sb = SUPPORT_SEVERITY_RANK[b.severity] ?? 4;
        if (sa !== sb)
            return sa - sb;
        return (b.created_at || '').localeCompare(a.created_at || '');
    });
}
/**
 * Resolve where a recent-activity row should navigate.
 * Returns null when the row is not actionable (mirrors web `rowIsActionable`).
 */
export function resolveActivityTarget(item: any) {
    if (!item)
        return null;
    const meta = item.meta || {};
    if (item.type === 'session_created' && meta.agentId) {
        return { kind: 'session', agentId: String(meta.agentId), sessionId: String(item.id) };
    }
    if (item.type === 'card_created' || item.type === 'card_updated') {
        const prUrl = meta.prUrl != null ? String(meta.prUrl) : '';
        const native = parseNativePrUrl(prUrl);
        if (native)
            return { kind: 'pulls', projectId: native.projectId, prNumber: native.number };
        if (prUrl)
            return { kind: 'external', url: prUrl };
        if (meta.projectId)
            return { kind: 'pulls', projectId: String(meta.projectId) };
    }
    if (item.type === 'escalation' && meta.projectId) {
        return { kind: 'kanban', projectId: String(meta.projectId) };
    }
    return null;
}
export function activityIsActionable(item: any) {
    return resolveActivityTarget(item) != null;
}
/** Resolve navigation for an open-PR dashboard row. */
export function resolveOpenPrTarget(pr: any) {
    const prUrl = pr?.prUrl != null ? String(pr.prUrl) : '';
    const native = parseNativePrUrl(prUrl);
    // Carry the parsed PR number so the Pull Requests screen opens that PR's
    // detail directly instead of dropping the user on the list.
    if (native)
        return { kind: 'pulls', projectId: native.projectId, prNumber: native.number };
    if (prUrl)
        return { kind: 'external', url: prUrl };
    if (pr?.projectId)
        return { kind: 'pulls', projectId: String(pr.projectId) };
    return null;
}
export function openPrIsActionable(pr: any) {
    return resolveOpenPrTarget(pr) != null;
}
