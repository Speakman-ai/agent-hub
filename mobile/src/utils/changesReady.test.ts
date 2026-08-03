// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { resolveAutoMergeDefault, parseChangesReady, hydrateChangesReady, hasCommittableChangesFromReady, } from './changesReady';
describe('resolveAutoMergeDefault', () => {
    it('returns false for null/undefined project', () => {
        expect(resolveAutoMergeDefault(null)).toBe(false);
        expect(resolveAutoMergeDefault(undefined)).toBe(false);
    });
    it('returns false when githubWorkflow is missing', () => {
        expect(resolveAutoMergeDefault({})).toBe(false);
        expect(resolveAutoMergeDefault({ id: 'p1' })).toBe(false);
    });
    it('returns false when autoMerge is not set', () => {
        expect(resolveAutoMergeDefault({ githubWorkflow: {} })).toBe(false);
    });
    it('returns false when autoMerge is explicitly false', () => {
        expect(resolveAutoMergeDefault({ githubWorkflow: { autoMerge: false } })).toBe(false);
    });
    it('returns true when autoMerge is true', () => {
        expect(resolveAutoMergeDefault({ githubWorkflow: { autoMerge: true } })).toBe(true);
    });
    it('coerces truthy-but-not-boolean autoMerge to a boolean', () => {
        expect(resolveAutoMergeDefault({ githubWorkflow: { autoMerge: 'yes' } })).toBe(true);
    });
});
describe('parseChangesReady', () => {
    it('returns null for falsy input', () => {
        expect(parseChangesReady(null)).toBeNull();
        expect(parseChangesReady(undefined)).toBeNull();
        expect(parseChangesReady('')).toBeNull();
        expect(parseChangesReady(0)).toBeNull();
    });
    it('parses a JSON string into an object', () => {
        const json = JSON.stringify({
            agentId: 'a1',
            branch: 'feature/x',
            hasUncommitted: true,
            hasUnpushed: false,
        });
        expect(parseChangesReady(json)).toEqual({
            agentId: 'a1',
            branch: 'feature/x',
            hasUncommitted: true,
            hasUnpushed: false,
        });
    });
    it('returns null for malformed JSON', () => {
        expect(parseChangesReady('{bad json')).toBeNull();
    });
    it('passes through an already-parsed object', () => {
        const obj = { agentId: 'a1', branch: 'main' };
        expect(parseChangesReady(obj)).toBe(obj);
    });
    it('returns null for a JSON string that parses to a non-object', () => {
        expect(parseChangesReady('"just a string"')).toBeNull();
        expect(parseChangesReady('42')).toBeNull();
    });
});
describe('hydrateChangesReady', () => {
    it('returns an empty object when sessions is not an array', () => {
        expect(hydrateChangesReady(null)).toEqual({});
        expect(hydrateChangesReady(undefined)).toEqual({});
        expect(hydrateChangesReady({})).toEqual({});
    });
    it('omits sessions without changes_ready', () => {
        const sessions = [
            { id: 's1', changes_ready: null },
            { id: 's2' /* changes_ready field missing */ },
        ];
        expect(hydrateChangesReady(sessions)).toEqual({});
    });
    it('hydrates JSON-string changes_ready into a sessionId map', () => {
        const sessions = [
            {
                id: 's1',
                changes_ready: JSON.stringify({
                    agentId: 'a1',
                    branch: 'feature/x',
                    hasUncommitted: true,
                    hasUnpushed: false,
                }),
            },
            { id: 's2', changes_ready: null },
            {
                id: 's3',
                changes_ready: {
                    agentId: 'a2',
                    branch: 'feature/y',
                    hasUncommitted: false,
                    hasUnpushed: true,
                },
            },
        ];
        const out = hydrateChangesReady(sessions);
        expect(Object.keys(out).sort()).toEqual(['s1', 's3']);
        expect(out.s1.branch).toBe('feature/x');
        expect(out.s3.branch).toBe('feature/y');
    });
    it('skips sessions whose changes_ready is malformed JSON', () => {
        const sessions = [
            { id: 's1', changes_ready: '{bad' },
            {
                id: 's2',
                changes_ready: JSON.stringify({ branch: 'ok' }),
            },
        ];
        const out = hydrateChangesReady(sessions);
        expect(Object.keys(out)).toEqual(['s2']);
    });
});
describe('hasCommittableChangesFromReady', () => {
    it('returns false for null/empty input', () => {
        expect(hasCommittableChangesFromReady(null)).toBe(false);
        expect(hasCommittableChangesFromReady({})).toBe(false);
    });
    it('returns true when the branch carries commits', () => {
        expect(hasCommittableChangesFromReady({ hasUncommitted: false, hasUnpushed: true })).toBe(true);
    });
    // Regression, mirroring the web client: uncommitted edits are not shippable
    // work. Counting them lit Finalize for a commit-less session, which then ran
    // a full review + CI cycle only to report that nothing would ship.
    it('returns false for uncommitted-only work', () => {
        expect(hasCommittableChangesFromReady({ hasUncommitted: true, hasUnpushed: false })).toBe(false);
    });
});
