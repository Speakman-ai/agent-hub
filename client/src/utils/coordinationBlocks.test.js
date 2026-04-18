import { describe, it, expect } from 'vitest';
import {
  parseHandoffBlock,
  parseDelegateBlock,
  extractCoordinationBlocks,
  detectHandoffBlock,
  describeHandoffReason,
} from './coordinationBlocks.js';

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
    const text = `<delegate>[{"agentId":"a","task":"do A"},{"agentId":"b","task":"do B"}]</delegate>`;
    expect(parseDelegateBlock(text)).toEqual([
      { agentId: 'a', task: 'do A' },
      { agentId: 'b', task: 'do B' },
    ]);
  });

  it('also accepts the legacy toAgent alias (regression: server-spec mismatch made delegate blocks render raw)', () => {
    const text = `<delegate>[{"toAgent":"a","task":"do A"}]</delegate>`;
    expect(parseDelegateBlock(text)).toEqual([{ agentId: 'a', task: 'do A' }]);
  });

  it('coerces a single object into a one-element array', () => {
    const text = `<delegate>{"agentId":"a","task":"do A"}</delegate>`;
    expect(parseDelegateBlock(text)).toEqual([{ agentId: 'a', task: 'do A' }]);
  });

  it('skips entries with missing fields', () => {
    const text = `<delegate>[{"agentId":"a","task":"x"},{"agentId":"","task":"y"},{"task":"z"}]</delegate>`;
    expect(parseDelegateBlock(text)).toEqual([{ agentId: 'a', task: 'x' }]);
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
    const text = `Splitting work.\n<delegate>[{"agentId":"a","task":"x"}]</delegate>`;
    const out = extractCoordinationBlocks(text);
    expect(out.stripped).toBe('Splitting work.');
    expect(out.delegate).toEqual([{ agentId: 'a', task: 'x' }]);
    expect(out.handoff).toBeNull();
  });

  it('strips a delegate block authored with the legacy toAgent alias so the raw JSON never leaks', () => {
    const text = `Splitting work.\n<delegate>[{"toAgent":"a","task":"x"}]</delegate>`;
    const out = extractCoordinationBlocks(text);
    // The critical assertion: stripped must not retain the raw <delegate> JSON.
    expect(out.stripped).toBe('Splitting work.');
    expect(out.delegate).toEqual([{ agentId: 'a', task: 'x' }]);
  });

  it('collapses excess blank lines left by stripping', () => {
    const text = `Line 1.\n\n\n\n<handoff>{"toAgent":"a","note":"b"}</handoff>\n\n\n`;
    const out = extractCoordinationBlocks(text);
    expect(out.stripped).toBe('Line 1.');
  });

  it('handles both block kinds in a single message (rare but possible)', () => {
    const text = `Prose.\n<handoff>{"toAgent":"a","note":"b"}</handoff>\n<delegate>[{"agentId":"c","task":"d"}]</delegate>`;
    const out = extractCoordinationBlocks(text);
    expect(out.stripped).toBe('Prose.');
    expect(out.handoff).toEqual({ toAgent: 'a', note: 'b' });
    expect(out.delegate).toEqual([{ agentId: 'c', task: 'd' }]);
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
    expect(out.handoffMalformed.reason).toBe('invalid-json');
    expect(out.handoffMalformed.rawBody).toBe('not json');
  });

  it('flags missing fields via handoffMalformed even when the JSON is syntactically valid', () => {
    const text = `<handoff>{"toAgent":"hub-backend"}</handoff>`;
    const out = extractCoordinationBlocks(text);
    expect(out.handoff).toBeNull();
    expect(out.handoffMalformed.reason).toBe('missing-note');
  });

  it('handles null/empty input safely', () => {
    expect(extractCoordinationBlocks('')).toEqual({
      stripped: '',
      handoff: null,
      delegate: null,
      handoffMalformed: null,
    });
    expect(extractCoordinationBlocks(null).stripped).toBe('');
    expect(extractCoordinationBlocks(null).handoffMalformed).toBeNull();
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
