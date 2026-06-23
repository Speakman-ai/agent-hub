// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { pickLinkedPrUrl, linkedPrBadge, dedupeSkillInvocations, formatInjectedBytes, normalizeSessionSummary, shouldShowViewChanges, splitSessionRoster, } from './sessionExtras';
describe('pickLinkedPrUrl', () => {
    it('prefers the linked card PR url', () => {
        expect(pickLinkedPrUrl({
            linkedCard: { pr_url: 'https://github.com/o/r/pull/1' },
            finalizePrUrl: 'https://github.com/o/r/pull/2',
            sessionTitlePrUrl: 'https://github.com/o/r/pull/3',
        })).toBe('https://github.com/o/r/pull/1');
    });
    it('falls back to finalizePrUrl then sessionTitlePrUrl', () => {
        expect(pickLinkedPrUrl({
            linkedCard: { pr_url: null },
            finalizePrUrl: 'https://github.com/o/r/pull/2',
            sessionTitlePrUrl: 'https://github.com/o/r/pull/3',
        })).toBe('https://github.com/o/r/pull/2');
        expect(pickLinkedPrUrl({ sessionTitlePrUrl: 'https://github.com/o/r/pull/3' })).toBe('https://github.com/o/r/pull/3');
    });
    it('returns null when nothing is linked', () => {
        expect(pickLinkedPrUrl({})).toBeNull();
        expect(pickLinkedPrUrl(null)).toBeNull();
        expect(pickLinkedPrUrl(undefined)).toBeNull();
    });
});
describe('linkedPrBadge', () => {
    const withUrl = (review_status: any) => ({
        linkedCard: { pr_url: 'https://github.com/o/r/pull/9', review_status },
    });
    it('returns null when no PR is linked', () => {
        expect(linkedPrBadge({})).toBeNull();
        expect(linkedPrBadge(null)).toBeNull();
    });
    it.each([
        ['merged', 'merged', 'purple'],
        ['changes_requested', 'pending_revisions', 'red'],
        ['approved', 'approved', 'emerald'],
        ['awaiting_review', 'pending_review', 'yellow'],
        ['reviewing', 'pending_review', 'yellow'],
    ])('maps review_status %s → %s (%s)', (status: any, key: any, tone: any) => {
        const badge = linkedPrBadge(withUrl(status));
        expect(badge.key).toBe(key);
        expect(badge.tone).toBe(tone);
    });
    it('is case-insensitive and defaults to a neutral Linked PR badge', () => {
        expect(linkedPrBadge(withUrl('APPROVED')).key).toBe('approved');
        expect(linkedPrBadge(withUrl(null))).toEqual({
            key: 'linked',
            label: 'Linked PR',
            tone: 'blue',
        });
        // finalize-run PR with no card at all still gets the neutral badge
        expect(linkedPrBadge({ finalizePrUrl: 'https://github.com/o/r/pull/2' }).key).toBe('linked');
    });
});
describe('dedupeSkillInvocations', () => {
    it('returns [] for non-arrays', () => {
        expect(dedupeSkillInvocations(null)).toEqual([]);
        expect(dedupeSkillInvocations(undefined)).toEqual([]);
        expect(dedupeSkillInvocations('x')).toEqual([]);
    });
    it('keeps the most recent row per skill id (camelCase rows)', () => {
        const rows = [
            { id: 1, skillId: 'kanban', createdAt: '2026-06-01T00:00:00Z' },
            { id: 2, skillId: 'kanban', createdAt: '2026-06-02T00:00:00Z' },
            { id: 3, skillId: 'wiki', createdAt: '2026-06-01T12:00:00Z' },
        ];
        const out = dedupeSkillInvocations(rows);
        expect(out).toHaveLength(2);
        expect(out.find((r: any) => r.skillId === 'kanban').id).toBe(2);
    });
    it('supports snake_case rows and skips rows without a skill id', () => {
        const rows = [
            { id: 1, skill_id: 's1', created_at: '2026-01-02' },
            { id: 2, skill_id: 's1', created_at: '2026-01-01' },
            { id: 3 },
            null,
        ];
        const out = dedupeSkillInvocations(rows);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe(1);
    });
});
describe('formatInjectedBytes', () => {
    it('formats B / KB / MB and rejects junk', () => {
        expect(formatInjectedBytes(512)).toBe('512 B');
        expect(formatInjectedBytes(1536)).toBe('1.5 KB');
        expect(formatInjectedBytes(2 * 1024 * 1024)).toBe('2.0 MB');
        expect(formatInjectedBytes(0)).toBe('');
        expect(formatInjectedBytes(-1)).toBe('');
        expect(formatInjectedBytes(NaN)).toBe('');
        expect(formatInjectedBytes(undefined)).toBe('');
    });
});
describe('normalizeSessionSummary', () => {
    it('flattens a full payload', () => {
        const data = {
            session: { id: 's1', name: 'Fix bug', engine: 'claude-code', model: 'claude-fable-5' },
            linkedCard: {
                id: 'c1',
                title: 'Bug card',
                pr_url: 'https://github.com/o/r/pull/42',
                review_status: 'approved',
                columnName: 'Review',
            },
            finalizePrUrl: null,
            sessionTitlePrUrl: null,
            skills: [
                { id: 'i1', skillId: 'kanban', status: 'loaded', injectedBytes: 2048, createdAt: '2026-06-10' },
            ],
        };
        const out = normalizeSessionSummary(data);
        expect(out.sessionName).toBe('Fix bug');
        expect(out.engine).toBe('claude-code');
        expect(out.model).toBe('claude-fable-5');
        expect(out.linkedPrUrl).toBe('https://github.com/o/r/pull/42');
        expect(out.prNumber).toBe('42');
        expect(out.prBadge.key).toBe('approved');
        expect(out.linkedCardId).toBe('c1');
        expect(out.linkedCardTitle).toBe('Bug card');
        expect(out.linkedCardColumn).toBe('Review');
        expect(out.skills).toEqual([
            { id: 'i1', skillId: 'kanban', status: 'loaded', injectedBytes: 2048, createdAt: '2026-06-10' },
        ]);
    });
    it('never throws on empty / partial payloads', () => {
        expect(normalizeSessionSummary(null)).toEqual({
            sessionName: '',
            engine: '',
            model: '',
            linkedPrUrl: null,
            prNumber: null,
            prBadge: null,
            linkedCardId: '',
            linkedCardTitle: '',
            linkedCardColumn: '',
            skills: [],
        });
        expect(normalizeSessionSummary({ skills: null }).skills).toEqual([]);
    });
    it('normalizes snake_case skill rows', () => {
        const out = normalizeSessionSummary({
            skills: [{ id: 'i2', skill_id: 'wiki', injected_bytes: 100, created_at: '2026-06-09' }],
        });
        expect(out.skills[0]).toEqual({
            id: 'i2',
            skillId: 'wiki',
            status: null,
            injectedBytes: 100,
            createdAt: '2026-06-09',
        });
    });
});
describe('shouldShowViewChanges', () => {
    it('defaults to showing when the session row is missing or has no flag', () => {
        expect(shouldShowViewChanges(null)).toBe(true);
        expect(shouldShowViewChanges(undefined)).toBe(true);
        expect(shouldShowViewChanges({})).toBe(true);
    });
    it('matches the use_worktree !== 0 convention', () => {
        expect(shouldShowViewChanges({ use_worktree: 1 })).toBe(true);
        expect(shouldShowViewChanges({ use_worktree: undefined })).toBe(true);
        expect(shouldShowViewChanges({ use_worktree: 0 })).toBe(false);
    });
});
describe('splitSessionRoster', () => {
    it('splits executor and advisors, tolerating junk', () => {
        const roster = [
            { id: 'a1', role: 'executor', name: 'Lead' },
            { id: 'a2', role: 'advisor', name: 'Helper' },
            { id: 'a3', role: 'advisor', name: 'Helper 2' },
            null,
        ];
        const out = splitSessionRoster(roster);
        expect(out.executor.id).toBe('a1');
        expect(out.advisors.map((a: any) => a.id)).toEqual(['a2', 'a3']);
    });
    it('handles empty input', () => {
        expect(splitSessionRoster(null)).toEqual({ executor: null, advisors: [] });
        expect(splitSessionRoster([])).toEqual({ executor: null, advisors: [] });
    });
});
