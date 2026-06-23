import { describe, it, expect } from 'vitest';
import {
  parseHandoffBlock,
  parseDelegateBlock,
  extractCoordinationBlocks,
  detectHandoffBlock,
  describeHandoffReason,
  detectDelegateBlock,
  describeDelegateReason,
  DELEGATE_REQUIRED_FIELDS,
} from './coordinationBlocks';

const delegateTask = (agentId: any = 'a', task: any = 'do A') => ({
  agentId,
  task,
  owner: 'hub-backend',
  scope: 'server-only',
  expectedArtifact: 'patch + tests',
  deadline: 'end-of-turn',
  returnFormat: 'summary',
});

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
    expect(parseDelegateBlock(text)).toEqual([
      delegateTask('a', 'do A'),
      delegateTask('b', 'do B'),
    ]);
  });

  it('accepts toAgent as an alias for agentId when the full contract is present', () => {
    const full = delegateTask('a', 'do A');
    const { agentId, ...rest } = full;
    const text = `<delegate>${JSON.stringify([{ toAgent: agentId, ...rest }])}</delegate>`;
    expect(parseDelegateBlock(text)).toEqual([full]);
  });

  it('accepts a single-object payload (normalized to a one-element array)', () => {
    const text = `<delegate>${JSON.stringify(delegateTask('a', 'do A'))}</delegate>`;
    expect(parseDelegateBlock(text)).toEqual([delegateTask('a', 'do A')]);
  });

  it('rejects entries with missing contract fields', () => {
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

  it('strips incomplete toAgent-only delegate blocks and surfaces delegateMalformed', () => {
    const text = `Splitting work.\n<delegate>[{"toAgent":"a","task":"x"}]</delegate>`;
    const out = extractCoordinationBlocks(text);
    expect(out.stripped).toBe('Splitting work.');
    expect(out.delegate).toBeNull();
    expect(out.delegateMalformed?.reason).toBe('no-valid-entries');
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

  it('handles both block kinds in a single message (rare but possible)', () => {
    const text = `Prose.\n<handoff>{"toAgent":"a","note":"b"}</handoff>\n<delegate>[${JSON.stringify(delegateTask('c', 'd'))}]</delegate>`;
    const out = extractCoordinationBlocks(text);
    expect(out.stripped).toBe('Prose.');
    expect(out.handoff).toEqual({ toAgent: 'a', note: 'b' });
    expect(out.delegate).toEqual([delegateTask('c', 'd')]);
  });

  it('does not strip a <handoff> example inside fenced markdown (suffix-only detection)', () => {
    const text = `# Protocol

Example:

\`\`\`json
<handoff>
{"toAgent":"hub-backend","note":"documentation only"}
</handoff>
\`\`\`

That is the wire format.
`;
    const out = extractCoordinationBlocks(text);
    expect(out.handoff).toBeNull();
    expect(out.handoffMalformed).toBeNull();
    expect(out.delegate).toBeNull();
    expect(out.stripped).toContain('<handoff>');
    expect(out.stripped).toContain('documentation only');
  });

  it('ignores a well-formed handoff that is not a message suffix', () => {
    const text = `Intro\n<handoff>{"toAgent":"a","note":"b"}</handoff>\nMore prose after.`;
    const out = extractCoordinationBlocks(text);
    expect(out.handoff).toBeNull();
    expect(out.stripped).toBe(text.trim());
  });

  it('strips a malformed block and surfaces handoffMalformed so the UI can render a failed card', () => {
    // Regression: previously extractCoordinationBlocks preserved the raw
    // `<handoff>...</handoff>` JSON as prose when parse failed, producing the
    // "handoffs intermittent — widget missing when they fail" bug. The
    // stripped prose must NOT contain the raw tag, and handoffMalformed must
    // carry a reason so SessionTail can render a HandoffCard in failed state.
    const text = `Prose.\n<handoff>not json</handoff>`;
    const out = extractCoordinationBlocks(text);
    expect(out.handoff).toBeNull();
    expect(out.stripped).toBe('Prose.');
    expect(out.stripped).not.toContain('<handoff>');
    expect(out.handoffMalformed).not.toBeNull();
    expect(out.handoffMalformed!.reason).toBe('invalid-json');
    expect(out.handoffMalformed!.rawBody).toBe('not json');
  });

  it('flags missing fields via handoffMalformed even when the JSON is syntactically valid', () => {
    const text = `<handoff>{"toAgent":"hub-backend"}</handoff>`;
    const out = extractCoordinationBlocks(text);
    expect(out.handoff).toBeNull();
    expect(out.handoffMalformed!.reason).toBe('missing-note');
  });

  it('handles null/empty input safely', () => {
    expect(extractCoordinationBlocks('')).toEqual({
      stripped: '',
      handoff: null,
      delegate: null,
      handoffMalformed: null,
      delegateMalformed: null,
    });
    expect(extractCoordinationBlocks(null).stripped).toBe('');
    expect(extractCoordinationBlocks(null).handoffMalformed).toBeNull();
    expect(extractCoordinationBlocks(null).delegateMalformed).toBeNull();
  });

  it('strips a malformed delegate block and surfaces delegateMalformed', () => {
    // Regression: before this fix the raw `<delegate>` JSON leaked into the
    // rendered prose when parsing failed, and the DelegationPanel never
    // populated (driven by WebSocket events, not message content), so the
    // user saw nothing actionable. The stripped prose must NOT contain the
    // raw tag, and delegateMalformed must carry a reason so the renderer
    // can surface a DelegateCard in failed state.
    const text = `Planning.\n<delegate>not json at all</delegate>`;
    const out = extractCoordinationBlocks(text);
    expect(out.delegate).toBeNull();
    expect(out.stripped).toBe('Planning.');
    expect(out.stripped).not.toContain('<delegate>');
    expect(out.delegateMalformed).not.toBeNull();
    expect(out.delegateMalformed!.reason).toBe('invalid-json');
    expect(out.delegateMalformed!.rawBody).toBe('not json at all');
  });

  it('flags empty delegate arrays as malformed', () => {
    const text = `<delegate>[]</delegate>`;
    const out = extractCoordinationBlocks(text);
    expect(out.delegate).toBeNull();
    expect(out.delegateMalformed!.reason).toBe('empty-array');
  });

  it('flags delegate arrays with no valid entries as malformed', () => {
    const text = `<delegate>[{"agentId":""}, {"task":""}]</delegate>`;
    const out = extractCoordinationBlocks(text);
    expect(out.delegate).toBeNull();
    expect(out.delegateMalformed!.reason).toBe('no-valid-entries');
  });
});

describe('detectDelegateBlock', () => {
  it('returns present=false when no block is in the text', () => {
    const out = detectDelegateBlock('plain prose');
    expect(out.present).toBe(false);
    expect(out.tasks).toBeNull();
    expect(out.reason).toBeNull();
  });

  it('returns tasks + reason=null for a valid block', () => {
    const out = detectDelegateBlock(
      `<delegate>[${JSON.stringify(delegateTask('a', 'x'))}]</delegate>`,
    );
    expect(out.present).toBe(true);
    expect(out.tasks).toEqual([delegateTask('a', 'x')]);
    expect(out.reason).toBeNull();
  });

  it('reports invalid-json for broken JSON bodies', () => {
    const out = detectDelegateBlock(`<delegate>{broken</delegate>`);
    expect(out.present).toBe(true);
    expect(out.tasks).toBeNull();
    expect(out.reason).toBe('invalid-json');
  });

  it('reports empty-array for an empty JSON array', () => {
    const out = detectDelegateBlock(`<delegate>[]</delegate>`);
    expect(out.reason).toBe('empty-array');
  });

  it('reports no-valid-entries when every task is missing required fields', () => {
    const out = detectDelegateBlock(
      `<delegate>[{"agentId":"","task":"y"},{"task":"z"}]</delegate>`,
    );
    expect(out.reason).toBe('no-valid-entries');
  });

  it('safely handles non-string / null input', () => {
    expect(detectDelegateBlock(null).present).toBe(false);
    expect(detectDelegateBlock(undefined).present).toBe(false);
    expect(detectDelegateBlock(42).present).toBe(false);
  });
});

describe('detectDelegateBlock — per-row missing-field diagnostics', () => {
  // Reproduces the bug report: user-facing card showed a generic "Failed —"
  // when the model emitted the short `[{agentId, task}]` form. The detector
  // must now surface which specific fields are missing per row so the UI
  // (and the model on its next turn) can self-correct.
  it('returns rows[] when every entry omits contract fields (the recurring user bug)', () => {
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

  it('reports missing agentId separately from missing contract fields', () => {
    const text = `<delegate>[{"task":"orphan"}]</delegate>`;
    const out = detectDelegateBlock(text);
    expect(out.reason).toBe('no-valid-entries');
    expect(out.rows![0].agentId).toBeNull();
    expect(out.rows![0].missing).toEqual([
      'agentId',
      'owner',
      'scope',
      'expectedArtifact',
      'deadline',
      'returnFormat',
    ]);
  });

  it('mixes valid rows with missing-field rows under missing-contract-fields', () => {
    const full = {
      agentId: 'a',
      task: 'do',
      owner: 'lead',
      scope: 's',
      expectedArtifact: 'e',
      deadline: 'd',
      returnFormat: 'r',
    };
    const text = `<delegate>[${JSON.stringify(full)},{"agentId":"b","task":"short"}]</delegate>`;
    const out = detectDelegateBlock(text);
    expect(out.reason).toBe('missing-contract-fields');
    expect(out.rows).toHaveLength(2);
    expect(out.rows![0].missing).toEqual([]);
    expect(out.rows![1]).toEqual({
      agentId: 'b',
      missing: ['owner', 'scope', 'expectedArtifact', 'deadline', 'returnFormat'],
    });
  });

  it('exports the canonical required field list so UIs can render the contract', () => {
    expect(DELEGATE_REQUIRED_FIELDS!).toEqual([
      'agentId',
      'task',
      'owner',
      'scope',
      'expectedArtifact',
      'deadline',
      'returnFormat',
    ]);
  });

  it('unwraps `{ tasks: [...] }` wrapper so the REST-style payload parses', () => {
    // Previously the wrapper was coerced to `[wrapper]` and failed
    // `no-valid-entries` because the wrapper has no `agentId`/`task`.
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

  it('surfaces per-row diagnostics for the wrapper shape when rows are partial', () => {
    const text = `<delegate>{"tasks":[{"agentId":"b","task":"short"}]}</delegate>`;
    const out = detectDelegateBlock(text);
    expect(out.reason).toBe('no-valid-entries');
    expect(out.rows).toEqual([
      {
        agentId: 'b',
        missing: ['owner', 'scope', 'expectedArtifact', 'deadline', 'returnFormat'],
      },
    ]);
  });

  it('threads rows[] through extractCoordinationBlocks.delegateMalformed', () => {
    const text = `Prose.\n<delegate>[{"agentId":"agent-hub-reviewer","task":"re-review"}]</delegate>`;
    const out = extractCoordinationBlocks(text);
    expect(out.delegate).toBeNull();
    expect(out.delegateMalformed!.reason).toBe('no-valid-entries');
    expect(out.delegateMalformed!.rows).toEqual([
      {
        agentId: 'agent-hub-reviewer',
        missing: ['owner', 'scope', 'expectedArtifact', 'deadline', 'returnFormat'],
      },
    ]);
  });
});

describe('describeDelegateReason', () => {
  it('returns a human-readable message for each reason code', () => {
    expect(describeDelegateReason('invalid-json')).toMatch(/invalid json/i);
    expect(describeDelegateReason('empty-array')).toMatch(/empty array/i);
    expect(describeDelegateReason('no-valid-entries')).toMatch(/agentid/i);
  });

  it('returns a generic fallback for unknown codes', () => {
    expect(describeDelegateReason('nope')).toMatch(/could not be parsed/i);
  });
});

describe('detectHandoffBlock', () => {
  it('returns present=false when no block is in the text', () => {
    const out = detectHandoffBlock('plain prose');
    expect(out.present).toBe(false);
    expect(out.task).toBeNull();
    expect(out.reason).toBeNull();
  });

  it('returns task + reason=null for a valid block', () => {
    const out = detectHandoffBlock(`<handoff>{"toAgent":"hub-backend","note":"go"}</handoff>`);
    expect(out.present).toBe(true);
    expect(out.task).toEqual({ toAgent: 'hub-backend', note: 'go' });
    expect(out.reason).toBeNull();
  });

  it('reports invalid-json for broken JSON bodies', () => {
    const out = detectHandoffBlock(`<handoff>{broken</handoff>`);
    expect(out.present).toBe(true);
    expect(out.task).toBeNull();
    expect(out.reason).toBe('invalid-json');
  });

  it('reports array-payload for array-shaped bodies', () => {
    const out = detectHandoffBlock(`<handoff>[{"toAgent":"x","note":"y"}]</handoff>`);
    expect(out.reason).toBe('array-payload');
  });

  it('reports missing vs empty fields distinctly', () => {
    expect(detectHandoffBlock(`<handoff>{"note":"y"}</handoff>`).reason).toBe('missing-toagent');
    expect(detectHandoffBlock(`<handoff>{"toAgent":"  ","note":"y"}</handoff>`).reason).toBe(
      'empty-toagent',
    );
    expect(detectHandoffBlock(`<handoff>{"toAgent":"x"}</handoff>`).reason).toBe('missing-note');
    expect(detectHandoffBlock(`<handoff>{"toAgent":"x","note":"  "}</handoff>`).reason).toBe(
      'empty-note',
    );
  });

  it('safely handles non-string / null input', () => {
    expect(detectHandoffBlock(null).present).toBe(false);
    expect(detectHandoffBlock(undefined).present).toBe(false);
    expect(detectHandoffBlock(42).present).toBe(false);
  });
});

describe('describeHandoffReason', () => {
  it('returns a human-readable message for each reason code', () => {
    expect(describeHandoffReason('invalid-json')).toMatch(/invalid json/i);
    expect(describeHandoffReason('missing-toagent')).toMatch(/toAgent/i);
    expect(describeHandoffReason('empty-note')).toMatch(/empty.*note/i);
  });

  it('returns a generic fallback for unknown codes', () => {
    expect(describeHandoffReason('nope')).toMatch(/could not be parsed/i);
  });
});
