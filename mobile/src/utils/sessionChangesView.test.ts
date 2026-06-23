// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { statusMeta, basename, dirname, normalizeChangesSummary, classifyDiffLine, parseUnifiedDiff, describeDiff, worktreeStatusLine, MAX_RENDER_LINES, resolveLiveSession, shouldFetchSessionRow, } from './sessionChangesView';
describe('statusMeta', () => {
    it('maps every known status', () => {
        expect(statusMeta('added')).toEqual({ short: 'A', label: 'Added', tone: 'add' });
        expect(statusMeta('deleted')).toEqual({ short: 'D', label: 'Deleted', tone: 'del' });
        expect(statusMeta('renamed')).toEqual({ short: 'R', label: 'Renamed', tone: 'info' });
        expect(statusMeta('copied')).toEqual({ short: 'C', label: 'Copied', tone: 'info' });
        expect(statusMeta('type-changed')).toEqual({
            short: 'T',
            label: 'Type changed',
            tone: 'warn',
        });
        expect(statusMeta('modified')).toEqual({ short: 'M', label: 'Modified', tone: 'warn' });
    });
    it('falls back to modified for unknown / missing statuses', () => {
        expect(statusMeta('weird')).toEqual(statusMeta('modified'));
        expect(statusMeta(undefined)).toEqual(statusMeta('modified'));
        expect(statusMeta(null)).toEqual(statusMeta('modified'));
    });
});
describe('basename / dirname', () => {
    it('splits a nested path', () => {
        expect(basename('src/utils/api.js')).toBe('api.js');
        expect(dirname('src/utils/api.js')).toBe('src/utils');
    });
    it('handles bare filenames', () => {
        expect(basename('README.md')).toBe('README.md');
        expect(dirname('README.md')).toBe('');
    });
    it('handles empty / nullish input', () => {
        expect(basename('')).toBe('');
        expect(dirname('')).toBe('');
        expect(basename(null)).toBe('');
        expect(dirname(undefined)).toBe('');
    });
});
describe('normalizeChangesSummary', () => {
    it('normalizes a full server payload and computes totals', () => {
        const body = {
            baseBranch: 'main',
            baseSha: 'abc',
            headSha: 'def',
            branch: 'agent-hub/a1/session-s1',
            dirty: true,
            truncated: false,
            files: [
                {
                    path: 'src/a.js',
                    status: 'modified',
                    additions: 3,
                    deletions: 1,
                    binary: false,
                    untracked: false,
                },
                {
                    path: 'src/new.js',
                    status: 'added',
                    additions: 10,
                    deletions: 0,
                    binary: false,
                    untracked: true,
                },
                {
                    path: 'src/b.js',
                    oldPath: 'src/old-b.js',
                    status: 'renamed',
                    additions: 0,
                    deletions: 0,
                    binary: false,
                    untracked: false,
                },
            ],
        };
        const s = normalizeChangesSummary(body);
        expect(s.branch).toBe('agent-hub/a1/session-s1');
        expect(s.baseBranch).toBe('main');
        expect(s.dirty).toBe(true);
        expect(s.truncated).toBe(false);
        expect(s.files).toHaveLength(3);
        expect(s.files[1]).toEqual({
            path: 'src/new.js',
            oldPath: null,
            status: 'added',
            additions: 10,
            deletions: 0,
            binary: false,
            untracked: true,
        });
        expect(s.files[2].oldPath).toBe('src/old-b.js');
        expect(s.totals).toEqual({ additions: 13, deletions: 1 });
    });
    it('tolerates a null body and a non-array files field', () => {
        expect(normalizeChangesSummary(null)).toEqual({
            branch: null,
            baseBranch: null,
            dirty: false,
            truncated: false,
            files: [],
            totals: { additions: 0, deletions: 0 },
        });
        expect(normalizeChangesSummary({ files: 'nope' }).files).toEqual([]);
    });
    it('drops entries without a string path and defaults missing fields', () => {
        const s = normalizeChangesSummary({
            files: [null, { status: 'added' }, { path: '' }, { path: 'ok.txt' }],
        });
        expect(s.files).toHaveLength(1);
        expect(s.files[0]).toEqual({
            path: 'ok.txt',
            oldPath: null,
            status: 'modified',
            additions: 0,
            deletions: 0,
            binary: false,
            untracked: false,
        });
    });
    it('coerces unknown statuses to modified and non-numeric counts to 0', () => {
        const s = normalizeChangesSummary({
            files: [{ path: 'x', status: 'mystery', additions: '4', deletions: NaN }],
        });
        expect(s.files[0].status).toBe('modified');
        expect(s.files[0].additions).toBe(0);
        expect(s.files[0].deletions).toBe(0);
    });
});
describe('classifyDiffLine', () => {
    it('classifies file headers as meta, not add/del', () => {
        expect(classifyDiffLine('+++ b/src/a.js')).toBe('meta');
        expect(classifyDiffLine('--- a/src/a.js')).toBe('meta');
    });
    it('classifies content additions and deletions', () => {
        expect(classifyDiffLine('+const x = 1;')).toBe('add');
        expect(classifyDiffLine('-const x = 0;')).toBe('del');
        expect(classifyDiffLine('+')).toBe('add');
        expect(classifyDiffLine('-')).toBe('del');
    });
    it('classifies hunk headers', () => {
        expect(classifyDiffLine('@@ -1,4 +1,6 @@ function foo()')).toBe('hunk');
    });
    it('classifies git metadata lines as meta', () => {
        expect(classifyDiffLine('diff --git a/x b/x')).toBe('meta');
        expect(classifyDiffLine('index 1234567..89abcde 100644')).toBe('meta');
        expect(classifyDiffLine('new file mode 100644')).toBe('meta');
        expect(classifyDiffLine('deleted file mode 100644')).toBe('meta');
        expect(classifyDiffLine('rename from a.js')).toBe('meta');
        expect(classifyDiffLine('rename to b.js')).toBe('meta');
        expect(classifyDiffLine('similarity index 97%')).toBe('meta');
        expect(classifyDiffLine('Binary files a/img.png and b/img.png differ')).toBe('meta');
        expect(classifyDiffLine('\\ No newline at end of file')).toBe('meta');
    });
    it('classifies everything else as context', () => {
        expect(classifyDiffLine(' unchanged line')).toBe('context');
        expect(classifyDiffLine('')).toBe('context');
        expect(classifyDiffLine(undefined)).toBe('context');
    });
});
describe('parseUnifiedDiff', () => {
    const sample = [
        'diff --git a/src/a.js b/src/a.js',
        'index 1111111..2222222 100644',
        '--- a/src/a.js',
        '+++ b/src/a.js',
        '@@ -1,2 +1,2 @@',
        ' const keep = true;',
        '-const x = 0;',
        '+const x = 1;',
    ].join('\n');
    it('splits and classifies each line', () => {
        const lines = parseUnifiedDiff(sample);
        expect(lines).toHaveLength(8);
        expect(lines.map((l: any) => l.type)).toEqual([
            'meta',
            'meta',
            'meta',
            'meta',
            'hunk',
            'context',
            'del',
            'add',
        ]);
        expect(lines[7].text).toBe('+const x = 1;');
    });
    it('trims exactly one trailing newline', () => {
        expect(parseUnifiedDiff('+a\n')).toHaveLength(1);
        expect(parseUnifiedDiff('+a\n\n')).toHaveLength(2);
    });
    it('returns [] for empty or non-string input', () => {
        expect(parseUnifiedDiff('')).toEqual([]);
        expect(parseUnifiedDiff('\n')).toEqual([]);
        expect(parseUnifiedDiff(null)).toEqual([]);
        expect(parseUnifiedDiff(undefined)).toEqual([]);
        expect(parseUnifiedDiff(42)).toEqual([]);
    });
});
describe('describeDiff', () => {
    it('returns loading when the diff has not arrived yet', () => {
        expect(describeDiff(null)).toEqual({ kind: 'loading' });
        expect(describeDiff(undefined)).toEqual({ kind: 'loading' });
    });
    it('surfaces fetch errors', () => {
        expect(describeDiff({ error: 'HTTP 500' })).toEqual({ kind: 'error', message: 'HTTP 500' });
    });
    it('flags binary and tooLarge before parsing (server sends empty body for both)', () => {
        expect(describeDiff({ binary: true, unifiedDiff: '', tooLarge: false })).toEqual({
            kind: 'binary',
        });
        expect(describeDiff({ binary: false, unifiedDiff: '', tooLarge: true })).toEqual({
            kind: 'tooLarge',
        });
    });
    it('returns empty when the diff body has no lines', () => {
        expect(describeDiff({ binary: false, tooLarge: false, unifiedDiff: '' })).toEqual({
            kind: 'empty',
        });
    });
    it('parses lines and reports zero hidden lines under the cap', () => {
        const d = describeDiff({ unifiedDiff: '+a\n-b\n' });
        expect(d.kind).toBe('diff');
        expect(d.lines).toHaveLength(2);
        expect(d.hiddenLines).toBe(0);
    });
    it('caps rendered lines and counts the hidden remainder', () => {
        const body = Array.from({ length: 10 }, (_: any, i: any) => `+line ${i}`).join('\n');
        const d = describeDiff({ unifiedDiff: body }, { maxLines: 4 });
        expect(d.lines).toHaveLength(4);
        expect(d.hiddenLines).toBe(6);
        expect(d.lines[3].text).toBe('+line 3');
    });
    it('exports a sane default cap', () => {
        expect(MAX_RENDER_LINES).toBeGreaterThan(0);
    });
});
describe('worktreeStatusLine', () => {
    it('returns null for missing / clean worktrees', () => {
        expect(worktreeStatusLine(null)).toBeNull();
        expect(worktreeStatusLine(undefined)).toBeNull();
        expect(worktreeStatusLine({ hasUncommitted: false, hasUnpushed: false })).toBeNull();
    });
    it('describes uncommitted and unpushed states', () => {
        expect(worktreeStatusLine({ hasUncommitted: true, hasUnpushed: false })).toBe('uncommitted changes');
        expect(worktreeStatusLine({ hasUncommitted: false, hasUnpushed: true })).toBe('unpushed commits');
        expect(worktreeStatusLine({ hasUncommitted: true, hasUnpushed: true })).toBe('uncommitted changes · unpushed commits');
    });
});
describe('resolveLiveSession', () => {
    const routeSession = { id: 's1', ask_mode: 1, finalize_automation: 'manual' };
    it('prefers the live app-context session over the route snapshot', () => {
        const live = { id: 's1', ask_mode: 0, finalize_automation: 'merge' };
        expect(resolveLiveSession({
            sessionId: 's1',
            sessions: [{ id: 's0' }, live],
            cronSessions: [],
            fetched: null,
            routeSession,
        })).toBe(live);
    });
    it('checks cronSessions when not found in sessions', () => {
        const cron = { id: 's1', finalize_automation: 'push' };
        expect(resolveLiveSession({
            sessionId: 's1',
            sessions: [{ id: 'other' }],
            cronSessions: [cron],
            fetched: null,
            routeSession,
        })).toBe(cron);
    });
    it('uses a directly-fetched row when context has no match', () => {
        const fetched = { id: 's1', ask_mode: 0, finalize_automation: 'review' };
        expect(resolveLiveSession({
            sessionId: 's1',
            sessions: [],
            cronSessions: [],
            fetched,
            routeSession,
        })).toBe(fetched);
    });
    it('ignores a fetched row whose id does not match (avoids cross-session bleed)', () => {
        const fetched = { id: 'other', finalize_automation: 'merge' };
        expect(resolveLiveSession({
            sessionId: 's1',
            sessions: [],
            cronSessions: [],
            fetched,
            routeSession,
        })).toBe(routeSession);
    });
    it('falls back to the route snapshot when nothing fresher exists', () => {
        expect(resolveLiveSession({ sessionId: 's1', sessions: [], cronSessions: [], routeSession })).toBe(routeSession);
        expect(resolveLiveSession({ sessionId: 's1', routeSession })).toBe(routeSession);
    });
    it('returns null when there is no session anywhere', () => {
        expect(resolveLiveSession({ sessionId: 's1', sessions: [], cronSessions: [] })).toBeNull();
        expect(resolveLiveSession({})).toBeNull();
    });
    it('tolerates non-array context inputs', () => {
        expect(resolveLiveSession({ sessionId: 's1', sessions: null, cronSessions: undefined, routeSession })).toBe(routeSession);
    });
});
describe('shouldFetchSessionRow', () => {
    it('fetches only when there is an id and no live context copy', () => {
        expect(shouldFetchSessionRow({ sessionId: 's1', contextSession: null })).toBe(true);
        expect(shouldFetchSessionRow({ sessionId: 's1', contextSession: { id: 's1' } })).toBe(false);
        expect(shouldFetchSessionRow({ sessionId: null, contextSession: null })).toBe(false);
        expect(shouldFetchSessionRow({})).toBe(false);
    });
});
