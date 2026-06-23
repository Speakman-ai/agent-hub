// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { parseHandoffBlock, parseDelegateBlock, extractCoordinationBlocks, pickHandoffRow, detectDelegateBlock, DELEGATE_REQUIRED_FIELDS, } from './coordinationBlocks';
const delegateTask = (agentId: any = 'a', task: any = 'do A') => ({
    agentId,
    task,
    owner: 'hub-backend',
    scope: 'server-only',
    expectedArtifact: 'patch + tests',
    deadline: 'end-of-turn',
    returnFormat: 'summary',
});
// Mirror of client/src/utils/coordinationBlocks.test.js so the mobile twin
// stays in parse-parity with the web util. New cases live below under
// `pickHandoffRow` for the mobile-only helper.
describe('parseHandoffBlock', () => {
    it('parses a well-formed handoff block', () => {
        const text = `Some prose.\n<handoff>{"toAgent": "hub-backend", "note": "implement the fix"}</handoff>`;
        expect(parseHandoffBlock(text)).toEqual({
            toAgent: 'hub-backend',
            note: 'implement the fix',
        });
    });
    it('tolerates surrounding whitespace inside the tags', () => {
        const text = `<handoff>\n  {"toAgent":"x","note":"y"}\n</handoff>`;
        expect(parseHandoffBlock(text)).toEqual({ toAgent: 'x', note: 'y' });
    });
    it('returns null when toAgent or note is missing/empty', () => {
        expect(parseHandoffBlock(`<handoff>{"toAgent":"x"}</handoff>`)).toBeNull();
        expect(parseHandoffBlock(`<handoff>{"note":"y"}</handoff>`)).toBeNull();
        expect(parseHandoffBlock(`<handoff>{"toAgent":"","note":"y"}</handoff>`)).toBeNull();
    });
    it('returns null on malformed JSON', () => {
        expect(parseHandoffBlock(`<handoff>not json</handoff>`)).toBeNull();
    });
    it('returns null when the JSON is an array (handoff is single-target)', () => {
        expect(parseHandoffBlock(`<handoff>[{"toAgent":"x","note":"y"}]</handoff>`)).toBeNull();
    });
    it('returns null when no block present', () => {
        expect(parseHandoffBlock('just a normal message')).toBeNull();
        expect(parseHandoffBlock('')).toBeNull();
        expect(parseHandoffBlock(null)).toBeNull();
    });
});
describe('parseDelegateBlock', () => {
    it('parses an array of tasks using the canonical agentId field', () => {
        const text = `<delegate>[${JSON.stringify(delegateTask('a', 'do A'))},${JSON.stringify(delegateTask('b', 'do B'))}]</delegate>`;
        expect(parseDelegateBlock(text)).toEqual([delegateTask('a', 'do A'), delegateTask('b', 'do B')]);
    });
    it('accepts toAgent as an alias for agentId when the full contract is present', () => {
        const full = delegateTask('a', 'do A');
        const { agentId, ...rest } = full;
        const text = `<delegate>${JSON.stringify([{ toAgent: agentId, ...rest }])}</delegate>`;
        expect(parseDelegateBlock(text)).toEqual([full]);
    });
    it('coerces a single object into a one-element array', () => {
        const text = `<delegate>${JSON.stringify(delegateTask('a', 'do A'))}</delegate>`;
        expect(parseDelegateBlock(text)).toEqual([delegateTask('a', 'do A')]);
    });
    it('returns null when some rows omit contract fields', () => {
        const text = `<delegate>[{"agentId":"a","task":"x"},{"agentId":"b","task":"y","owner":"x"}]</delegate>`;
        expect(parseDelegateBlock(text)).toBeNull();
    });
    it('returns null when no valid entries remain', () => {
        const text = `<delegate>[{"agentId":""}]</delegate>`;
        expect(parseDelegateBlock(text)).toBeNull();
    });
    it('returns null on malformed JSON', () => {
        expect(parseDelegateBlock(`<delegate>{nope}</delegate>`)).toBeNull();
    });
    it('returns null when no block present', () => {
        expect(parseDelegateBlock('hello')).toBeNull();
    });
});
describe('extractCoordinationBlocks', () => {
    it('returns the original text and nulls when no blocks are present', () => {
        const out = extractCoordinationBlocks('plain message');
        expect(out.stripped).toBe('plain message');
        expect(out.handoff).toBeNull();
        expect(out.delegate).toBeNull();
    });
    it('strips a handoff block and returns the parsed task', () => {
        const text = `Done discovery.\n\n<handoff>{"toAgent":"hub-backend","note":"please ship"}</handoff>`;
        const out = extractCoordinationBlocks(text);
        expect(out.stripped).toBe('Done discovery.');
        expect(out.handoff).toEqual({ toAgent: 'hub-backend', note: 'please ship' });
        expect(out.delegate).toBeNull();
    });
    it('strips a delegate block and returns the parsed tasks (server-spec agentId format)', () => {
        const text = `Splitting work.\n<delegate>[${JSON.stringify(delegateTask('a', 'x'))}]</delegate>`;
        const out = extractCoordinationBlocks(text);
        expect(out.stripped).toBe('Splitting work.');
        expect(out.delegate).toEqual([delegateTask('a', 'x')]);
        expect(out.handoff).toBeNull();
    });
    it('strips a delegate block that uses toAgent with the full contract', () => {
        const full = delegateTask('a', 'x');
        const { agentId, ...rest } = full;
        const text = `Splitting work.\n<delegate>${JSON.stringify([{ toAgent: agentId, ...rest }])}</delegate>`;
        const out = extractCoordinationBlocks(text);
        expect(out.stripped).toBe('Splitting work.');
        expect(out.delegate).toEqual([full]);
    });
    it('collapses excess blank lines left by stripping', () => {
        const text = `Line 1.\n\n\n\n<handoff>{"toAgent":"a","note":"b"}</handoff>\n\n\n`;
        const out = extractCoordinationBlocks(text);
        expect(out.stripped).toBe('Line 1.');
    });
    it('handles both block kinds in a single message', () => {
        const text = `Prose.\n<handoff>{"toAgent":"a","note":"b"}</handoff>\n<delegate>[${JSON.stringify(delegateTask('c', 'd'))}]</delegate>`;
        const out = extractCoordinationBlocks(text);
        expect(out.stripped).toBe('Prose.');
        expect(out.handoff).toEqual({ toAgent: 'a', note: 'b' });
        expect(out.delegate).toEqual([delegateTask('c', 'd')]);
    });
    it('peels delegate after handoff when delegate is inner suffix (matches web loop)', () => {
        const text = `Prose.\n<delegate>[${JSON.stringify(delegateTask('c', 'd'))}]</delegate>\n<handoff>{"toAgent":"a","note":"b"}</handoff>`;
        const out = extractCoordinationBlocks(text);
        expect(out.stripped).toBe('Prose.');
        expect(out.handoff).toEqual({ toAgent: 'a', note: 'b' });
        expect(out.delegate).toEqual([delegateTask('c', 'd')]);
        expect(out.stripped).not.toMatch(/<delegate>|<handoff>/);
    });
    it('does not treat a fenced <handoff> example as a protocol block', () => {
        const text = `# Doc

\`\`\`json
<handoff>
{"toAgent":"hub-backend","note":"example"}
</handoff>
\`\`\`
`;
        const out = extractCoordinationBlocks(text);
        expect(out.handoff).toBeNull();
        expect(out.delegate).toBeNull();
        expect(out.stripped).toContain('<handoff>');
    });
    it('leaves a malformed block in place but returns null for the parsed value', () => {
        const text = `Prose.\n<handoff>not json</handoff>`;
        const out = extractCoordinationBlocks(text);
        expect(out.handoff).toBeNull();
        expect(out.stripped).toContain('<handoff>');
    });
    it('handles null/empty input safely', () => {
        expect(extractCoordinationBlocks('')).toEqual({ stripped: '', handoff: null, delegate: null });
        expect(extractCoordinationBlocks(null).stripped).toBe('');
    });
});
describe('detectDelegateBlock — parity with client util', () => {
    it('exposes per-row diagnostics for the recurring {agentId, task}-only payload', () => {
        const text = `<delegate>[{"agentId":"agent-hub-reviewer","task":"Re-review PR #648"}]</delegate>`;
        const out = detectDelegateBlock(text);
        expect(out.reason).toBe('no-valid-entries');
        expect(out.tasks).toBeNull();
        expect(out.rows).toEqual([
            {
                agentId: 'agent-hub-reviewer',
                missing: ['owner', 'scope', 'expectedArtifact', 'deadline', 'returnFormat'],
            },
        ]);
    });
    it('unwraps `{ tasks: [...] }` wrapper shape (parity with web + server)', () => {
        const full = {
            agentId: 'a',
            task: 'do',
            owner: 'lead',
            scope: 's',
            expectedArtifact: 'e',
            deadline: 'd',
            returnFormat: 'r',
        };
        const text = `<delegate>${JSON.stringify({ tasks: [full] })}</delegate>`;
        const out = detectDelegateBlock(text);
        expect(out.tasks).toEqual([full]);
        expect(out.reason).toBeNull();
    });
    it('keeps the canonical field list in parity with the web util', () => {
        expect(DELEGATE_REQUIRED_FIELDS).toEqual([
            'agentId',
            'task',
            'owner',
            'scope',
            'expectedArtifact',
            'deadline',
            'returnFormat',
        ]);
    });
});
describe('pickHandoffRow', () => {
    const block = { toAgent: 'hub-backend', note: 'x' };
    const delivered = {
        id: 1,
        to_agent_id: 'hub-backend',
        to_session_id: 's-1',
        status: 'delivered',
    };
    const pending = {
        id: 2,
        to_agent_id: 'hub-backend',
        to_session_id: null,
        status: 'pending',
    };
    const failed = {
        id: 3,
        to_agent_id: 'hub-frontend',
        to_session_id: null,
        status: 'failed',
        error: 'boom',
    };
    it('returns null when there are no rows', () => {
        expect(pickHandoffRow(block, [])).toBeNull();
        expect(pickHandoffRow(block, null)).toBeNull();
        expect(pickHandoffRow(block, undefined)).toBeNull();
    });
    it('prefers a delivered row over a pending row for the same target', () => {
        expect(pickHandoffRow(block, [pending, delivered])).toBe(delivered);
    });
    it('falls back to the first matching row when nothing is delivered yet', () => {
        expect(pickHandoffRow(block, [pending])).toBe(pending);
    });
    it('matches agent ids fuzzily so server-side rewrites still resolve', () => {
        // Server rewrites "agent-hub-backend" → "hub-backend"; the raw block id
        // can be either form. The matcher accepts hyphen-substring on either side.
        const rewritten = { ...delivered, to_agent_id: 'hub-backend' };
        expect(pickHandoffRow({ toAgent: 'agent-hub-backend' }, [rewritten])).toBe(rewritten);
    });
    it('falls back to a single-row list when no match is found (handoff is terminal)', () => {
        // Source session has exactly one handoff row, and the block mentions a
        // differently-named target (rare, but we still want to surface status).
        expect(pickHandoffRow({ toAgent: 'something-else' }, [failed])).toBe(failed);
    });
    it('does not fall back when multiple rows exist and none match', () => {
        expect(pickHandoffRow({ toAgent: 'other' }, [delivered, failed])).toBeNull();
    });
    it('returns null when the block is missing toAgent', () => {
        // With no wanted id and multiple rows we can't safely guess.
        expect(pickHandoffRow({}, [delivered, failed])).toBeNull();
    });
});
