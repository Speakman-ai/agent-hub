// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { formatHeadlineTiles, priorityRows, columnRows, activityLabel, filterActivity, countByType, ACTIVITY_TYPE_KEYS, HEADLINE_TILES, PRIORITY_KEYS, sortSupportBySeverity, resolveActivityTarget, activityIsActionable, resolveOpenPrTarget, openPrIsActionable, } from './dashboard';
describe('formatHeadlineTiles', () => {
    it('returns one tile per canonical key in display order', () => {
        const tiles = formatHeadlineTiles({
            projects: 4,
            agents: 9,
            sessions: 123,
            activeSessions: 2,
            openCards: 17,
            openPRs: 3,
            escalations: 1,
        });
        expect(tiles).toHaveLength(HEADLINE_TILES.length);
        expect(tiles.map((t: any) => t.key)).toEqual(HEADLINE_TILES.map((t: any) => t.key));
        const byKey = Object.fromEntries(tiles.map((t: any) => [t.key, t.value]));
        expect(byKey.projects).toBe(4);
        expect(byKey.openPRs).toBe(3);
        expect(byKey.escalations).toBe(1);
    });
    it('defaults missing keys to 0', () => {
        const tiles = formatHeadlineTiles({});
        for (const t of tiles)
            expect(t.value).toBe(0);
    });
    it('coerces string counts to numbers', () => {
        const tiles = formatHeadlineTiles({ projects: '7' });
        expect(tiles.find((t: any) => t.key === 'projects').value).toBe(7);
    });
    it('handles a missing payload entirely', () => {
        expect(formatHeadlineTiles()).toHaveLength(HEADLINE_TILES.length);
    });
});
describe('priorityRows', () => {
    it('returns rows in fixed priority order with computed percent', () => {
        const rows = priorityRows({ urgent: 2, high: 4, medium: 8, low: 0 });
        expect(rows.map((r: any) => r.key)).toEqual(PRIORITY_KEYS);
        expect(rows.find((r: any) => r.key === 'medium').count).toBe(8);
        expect(rows.find((r: any) => r.key === 'medium').percent).toBe(100);
        // Urgent: 2/8 = 25%
        expect(rows.find((r: any) => r.key === 'urgent').percent).toBe(25);
        expect(rows.find((r: any) => r.key === 'low').percent).toBe(0);
    });
    it('handles all-zero buckets without divide-by-zero', () => {
        const rows = priorityRows({ urgent: 0, high: 0, medium: 0, low: 0 });
        for (const r of rows)
            expect(r.percent).toBe(0);
    });
    it('treats missing buckets as zero', () => {
        const rows = priorityRows({});
        expect(rows).toHaveLength(PRIORITY_KEYS.length);
        for (const r of rows) {
            expect(r.count).toBe(0);
            expect(r.percent).toBe(0);
        }
    });
});
describe('columnRows', () => {
    it('preserves server-provided ordering and computes percent of max', () => {
        const rows = columnRows([
            { columnName: 'To Do', count: 20 },
            { columnName: 'In Progress', count: 5 },
            { columnName: 'Review', count: 0 },
        ]);
        expect(rows.map((r: any) => r.columnName)).toEqual(['To Do', 'In Progress', 'Review']);
        expect(rows[0].percent).toBe(100);
        expect(rows[1].percent).toBe(25);
        expect(rows[2].percent).toBe(0);
    });
    it('returns an empty array for an empty input', () => {
        expect(columnRows([])).toEqual([]);
    });
});
describe('activityLabel', () => {
    it('maps known event types to friendly labels', () => {
        expect(activityLabel('card_created')).toBe('Card created');
        expect(activityLabel('card_updated')).toBe('Card updated');
        expect(activityLabel('session_created')).toBe('Session started');
        expect(activityLabel('escalation')).toBe('Escalation');
        expect(activityLabel('pr_created')).toBe('PR opened');
    });
    it('falls back to a generic label for unknown types', () => {
        expect(activityLabel('zoltan')).toBe('Activity');
        expect(activityLabel(undefined)).toBe('Activity');
    });
});
const SAMPLE_ACTIVITY = [
    { type: 'card_created', id: 'c1' },
    { type: 'card_updated', id: 'c2' },
    { type: 'card_created', id: 'c3' },
    { type: 'session_created', id: 's1' },
    { type: 'escalation', id: 'e1' },
    { type: 'pr_created', id: 'p1' },
];
describe('filterActivity', () => {
    it('returns the full list when no filter is active', () => {
        expect(filterActivity(SAMPLE_ACTIVITY, new Set())).toEqual(SAMPLE_ACTIVITY);
        expect(filterActivity(SAMPLE_ACTIVITY, [])).toEqual(SAMPLE_ACTIVITY);
        expect(filterActivity(SAMPLE_ACTIVITY, null)).toEqual(SAMPLE_ACTIVITY);
        expect(filterActivity(SAMPLE_ACTIVITY, undefined)).toEqual(SAMPLE_ACTIVITY);
    });
    it('narrows the list when filter contains one type', () => {
        const result = filterActivity(SAMPLE_ACTIVITY, new Set(['card_created']));
        expect(result.map((i: any) => i.id)).toEqual(['c1', 'c3']);
    });
    it('narrows the list across multiple selected types', () => {
        const result = filterActivity(SAMPLE_ACTIVITY, ['session_created', 'escalation']);
        expect(result.map((i: any) => i.id)).toEqual(['s1', 'e1']);
    });
    it('returns an empty list when filter matches nothing', () => {
        const result = filterActivity(SAMPLE_ACTIVITY, new Set(['nope']));
        expect(result).toEqual([]);
    });
    it('handles invalid or missing items gracefully', () => {
        expect(filterActivity(null, new Set(['card_created']))).toEqual([]);
        expect(filterActivity(undefined, new Set(['card_created']))).toEqual([]);
        // Items without a `type` are filtered out when a narrow filter is on.
        const result = filterActivity([{ id: 'x' }, ...SAMPLE_ACTIVITY], new Set(['card_created']));
        expect(result.map((i: any) => i.id)).toEqual(['c1', 'c3']);
    });
});
describe('countByType', () => {
    it('returns a count map keyed by activity type', () => {
        const counts = countByType(SAMPLE_ACTIVITY);
        expect(counts).toEqual({
            card_created: 2,
            card_updated: 1,
            session_created: 1,
            escalation: 1,
            pr_created: 1,
        });
    });
    it('returns an empty object for empty or invalid input', () => {
        expect(countByType([])).toEqual({});
        expect(countByType(null)).toEqual({});
        expect(countByType(undefined)).toEqual({});
    });
    it('ignores items without a type', () => {
        expect(countByType([{ id: 'x' }, { type: 'pr_created', id: 'p' }])).toEqual({
            pr_created: 1,
        });
    });
});
describe('ACTIVITY_TYPE_KEYS', () => {
    it('lists every known type once in canonical order', () => {
        expect(ACTIVITY_TYPE_KEYS).toEqual([
            'card_created',
            'card_updated',
            'session_created',
            'escalation',
            'pr_created',
        ]);
    });
});
describe('sortSupportBySeverity', () => {
    it('orders critical before high before medium before low', () => {
        const sorted = sortSupportBySeverity([
            { id: '1', severity: 'low', created_at: '2026-01-03T00:00:00Z' },
            { id: '2', severity: 'critical', created_at: '2026-01-01T00:00:00Z' },
            { id: '3', severity: 'high', created_at: '2026-01-02T00:00:00Z' },
        ]);
        expect(sorted.map((t: any) => t.id)).toEqual(['2', '3', '1']);
    });
    it('sorts newest-first within the same severity', () => {
        const sorted = sortSupportBySeverity([
            { id: 'a', severity: 'high', created_at: '2026-01-01T00:00:00Z' },
            { id: 'b', severity: 'high', created_at: '2026-01-03T00:00:00Z' },
        ]);
        expect(sorted.map((t: any) => t.id)).toEqual(['b', 'a']);
    });
    it('does not mutate the input array', () => {
        const input = [{ id: 'x', severity: 'low', created_at: '2026-01-01T00:00:00Z' }];
        sortSupportBySeverity(input);
        expect(input).toHaveLength(1);
    });
});
describe('resolveActivityTarget', () => {
    it('routes session_created via meta.agentId', () => {
        expect(resolveActivityTarget({
            type: 'session_created',
            id: 'sess-1',
            meta: { agentId: 'agent-a' },
        })).toEqual({ kind: 'session', agentId: 'agent-a', sessionId: 'sess-1' });
    });
    it('routes card rows with native PR URLs to pulls, carrying the PR number', () => {
        expect(resolveActivityTarget({
            type: 'card_updated',
            id: 'c1',
            meta: {
                projectId: 'proj-1',
                prUrl: '/projects/proj-1/pulls/42',
            },
        })).toEqual({ kind: 'pulls', projectId: 'proj-1', prNumber: 42 });
    });
    it('routes card rows with external PR URLs externally', () => {
        expect(resolveActivityTarget({
            type: 'card_created',
            id: 'c1',
            meta: {
                projectId: 'proj-1',
                prUrl: 'https://github.com/o/r/pull/9',
            },
        })).toEqual({ kind: 'external', url: 'https://github.com/o/r/pull/9' });
    });
    it('routes escalation rows to kanban', () => {
        expect(resolveActivityTarget({
            type: 'escalation',
            id: 'e1',
            meta: { projectId: 'proj-2' },
        })).toEqual({ kind: 'kanban', projectId: 'proj-2' });
    });
    it('returns null for pr_created (not actionable on web)', () => {
        expect(resolveActivityTarget({
            type: 'pr_created',
            id: 'p1',
            meta: { projectId: 'proj-1' },
        })).toBeNull();
        expect(activityIsActionable({
            type: 'pr_created',
            id: 'p1',
            meta: { projectId: 'proj-1' },
        })).toBe(false);
    });
});
describe('resolveOpenPrTarget', () => {
    it('prefers native PR URLs and carries the parsed PR number', () => {
        // Regression: the parsed PR number used to be discarded, so the row opened
        // the Pull Requests list instead of the specific PR's detail.
        expect(resolveOpenPrTarget({
            projectId: 'proj-1',
            prUrl: 'https://hub.example.com/projects/proj-1/pulls/7',
        })).toEqual({ kind: 'pulls', projectId: 'proj-1', prNumber: 7 });
    });
    it('falls back to project pulls (no number) when only projectId is present', () => {
        expect(resolveOpenPrTarget({ projectId: 'proj-9' })).toEqual({
            kind: 'pulls',
            projectId: 'proj-9',
        });
        expect(openPrIsActionable({ projectId: 'proj-9' })).toBe(true);
    });
});
