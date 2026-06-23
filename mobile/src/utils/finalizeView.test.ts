// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { summarizeChecks, groupThreadsByFile, deriveFinalizeButton, canPush, isFullyValidated, emptyFinalizeRunState, normalizeFinalizeRunResult, emptyReviewerThreads, normalizeReviewerThreads, isFreshGeneration, } from './finalizeView';
describe('summarizeChecks', () => {
    it('handles no steps', () => {
        expect(summarizeChecks(null)).toMatchObject({ total: 0, allPassed: false, headline: 'No checks yet' });
        expect(summarizeChecks([])).toMatchObject({ total: 0, headline: 'No checks yet' });
    });
    it('counts all passed', () => {
        const r = summarizeChecks([{ state: 'passed' }, { state: 'passed' }]);
        expect(r).toMatchObject({ total: 2, passed: 2, failed: 0, allPassed: true, headline: '2/2 passed' });
    });
    it('surfaces the first failed step name', () => {
        const r = summarizeChecks([
            { name: 'lint', state: 'passed' },
            { name: 'tests', state: 'failed' },
            { name: 'build', state: 'failed' },
        ]);
        expect(r.failed).toBe(2);
        expect(r.failedName).toBe('tests');
        expect(r.headline).toBe('tests failed');
        expect(r.allPassed).toBe(false);
    });
    it('reports running progress', () => {
        const r = summarizeChecks([
            { name: 'lint', state: 'passed' },
            { name: 'tests', state: 'running' },
        ]);
        expect(r.running).toBe(1);
        expect(r.headline).toBe('1/2 passed · running');
    });
});
describe('groupThreadsByFile', () => {
    it('groups by file_path preserving first-seen order', () => {
        const groups = groupThreadsByFile([
            { file_path: 'b.ts', body: '1' },
            { file_path: 'a.ts', body: '2' },
            { file_path: 'b.ts', body: '3' },
        ]);
        expect(groups.map((g: any) => g.file)).toEqual(['b.ts', 'a.ts']);
        expect(groups[0].items).toHaveLength(2);
    });
    it('buckets threads without a file under (general)', () => {
        const groups = groupThreadsByFile([{ body: 'x' }]);
        expect(groups[0].file).toBe('(general)');
    });
    it('handles empty / nullish input', () => {
        expect(groupThreadsByFile(null)).toEqual([]);
        expect(groupThreadsByFile(undefined)).toEqual([]);
    });
});
describe('deriveFinalizeButton', () => {
    it('shows Stop while a run is in flight', () => {
        expect(deriveFinalizeButton({ status: 'running' })).toMatchObject({
            label: 'Stop',
            inFlight: true,
            tone: 'busy',
            disabled: false,
        });
    });
    it('shows Finalized when fully validated', () => {
        expect(deriveFinalizeButton({ status: 'ready_to_push', fullyValidated: true })).toMatchObject({
            label: 'Finalized',
            tone: 'done',
        });
    });
    it('shows Finalize when idle with changes, disabled without changes', () => {
        expect(deriveFinalizeButton({ status: null, hasChanges: true })).toMatchObject({
            label: 'Finalize',
            disabled: false,
        });
        expect(deriveFinalizeButton({ status: null, hasChanges: false }).disabled).toBe(true);
    });
});
describe('canPush', () => {
    it('allows push at ready_to_push regardless of changes', () => {
        expect(canPush({ status: 'ready_to_push', hasChanges: false })).toBe(true);
    });
    it('blocks push mid-run', () => {
        expect(canPush({ status: 'running', hasChanges: true })).toBe(false);
    });
    it('allows push when idle/terminal with committable changes', () => {
        expect(canPush({ status: 'pushed', hasChanges: true })).toBe(true);
        expect(canPush({ status: null, hasChanges: true })).toBe(true);
        expect(canPush({ status: null, hasChanges: false })).toBe(false);
    });
});
describe('isFullyValidated', () => {
    it('true only when both phases passed on the same HEAD', () => {
        expect(isFullyValidated({
            checks: { status: 'ready_to_push', validated_head_sha: 'abc' },
            review: { status: 'ready_to_push', validated_head_sha: 'abc' },
        })).toBe(true);
    });
    it('false when HEADs differ', () => {
        expect(isFullyValidated({
            checks: { status: 'ready_to_push', validated_head_sha: 'abc' },
            review: { status: 'ready_to_push', validated_head_sha: 'def' },
        })).toBe(false);
    });
    it('false when a phase is missing or not passed', () => {
        expect(isFullyValidated(null)).toBe(false);
        expect(isFullyValidated({ checks: { status: 'ready_to_push', validated_head_sha: 'a' } })).toBe(false);
        expect(isFullyValidated({
            checks: { status: 'running', validated_head_sha: 'a' },
            review: { status: 'ready_to_push', validated_head_sha: 'a' },
        })).toBe(false);
    });
});
describe('emptyFinalizeRunState', () => {
    it('clears run/steps/phases so a new session shows no prior run', () => {
        // This is the value useFinalizeRunPoll resets to when sessionId changes —
        // it must carry no run id/status (which would let Stop/Push act on the
        // wrong finalize run) until the first poll for the new session resolves.
        expect(emptyFinalizeRunState()).toEqual({ run: null, steps: [], phases: null });
    });
    it('returns a fresh object each call (no shared mutable state)', () => {
        const a = emptyFinalizeRunState();
        a.steps.push('x');
        expect(emptyFinalizeRunState().steps).toEqual([]);
    });
});
describe('normalizeFinalizeRunResult', () => {
    it('maps a full payload through unchanged', () => {
        const run = { id: 'r1', status: 'running' };
        const steps = [{ name: 'build', state: 'passed' }];
        const phases = { checks: {}, review: {} };
        expect(normalizeFinalizeRunResult({ run, steps, phases })).toEqual({ run, steps, phases });
    });
    it('collapses missing/garbage fields to the cleared shape', () => {
        expect(normalizeFinalizeRunResult(null)).toEqual(emptyFinalizeRunState());
        expect(normalizeFinalizeRunResult({})).toEqual(emptyFinalizeRunState());
        // A partial response must not smuggle a stale run through a bad steps field.
        expect(normalizeFinalizeRunResult({ steps: 'nope' })).toEqual({
            run: null,
            steps: [],
            phases: null,
        });
    });
});
describe('emptyReviewerThreads', () => {
    it('clears threads + verdict so a new run shows no prior review', () => {
        // ReviewerThreadsCard resets to this when projectId/runId changes so an
        // old run's findings/verdict never render under a new run.
        expect(emptyReviewerThreads()).toEqual({ threads: [], verdict: null });
    });
    it('returns a fresh object each call', () => {
        const a = emptyReviewerThreads();
        a.threads.push('x');
        expect(emptyReviewerThreads().threads).toEqual([]);
    });
});
describe('normalizeReviewerThreads', () => {
    it('extracts threads and reviewer_verdict', () => {
        const threads = [{ id: 't1', file_path: 'a.js', body: 'x' }];
        expect(normalizeReviewerThreads({ threads, reviewer_verdict: 'changes_requested' })).toEqual({
            threads,
            verdict: 'changes_requested',
        });
    });
    it('collapses missing/garbage fields to the cleared shape', () => {
        expect(normalizeReviewerThreads(null)).toEqual(emptyReviewerThreads());
        expect(normalizeReviewerThreads({})).toEqual(emptyReviewerThreads());
        expect(normalizeReviewerThreads({ threads: 'nope' })).toEqual({ threads: [], verdict: null });
    });
});
describe('isFreshGeneration', () => {
    it('is fresh only when the captured token matches the live one', () => {
        expect(isFreshGeneration(3, 3)).toBe(true);
        expect(isFreshGeneration(3, 4)).toBe(false);
        expect(isFreshGeneration(4, 3)).toBe(false);
    });
    it('drops a response that resolves after the key changed (the wrong-run race)', () => {
        // Model the poll loop: effect for session/run A bumps the generation and a
        // request captures it. The key changes to B before A's request resolves —
        // the effect (and cleanup) bump the generation again. A's late response
        // must be rejected so it can't install under B.
        let gen = 0;
        gen += 1; // effect A
        const capturedByA = gen; // request for A starts, captures the token
        gen += 1; // A cleanup invalidates the generation
        gen += 1; // effect B
        // A's request now resolves out of order:
        expect(isFreshGeneration(capturedByA, gen)).toBe(false);
        // B's own in-flight request, captured under the current generation, applies:
        const capturedByB = gen;
        expect(isFreshGeneration(capturedByB, gen)).toBe(true);
    });
    it('keeps a response from a same-generation re-fetch (e.g. status-driven poll)', () => {
        // Polling the same run repeatedly does not bump the generation, so each
        // in-order response is applied.
        const gen = 7;
        const captured = gen;
        expect(isFreshGeneration(captured, gen)).toBe(true);
    });
});
