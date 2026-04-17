import { describe, it, expect } from 'vitest';
import {
  parseHandoffBlock,
  parseDelegateBlock,
  extractCoordinationBlocks,
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

  it('leaves a malformed block in place but returns null for the parsed value', () => {
    const text = `Prose.\n<handoff>not json</handoff>`;
    const out = extractCoordinationBlocks(text);
    expect(out.handoff).toBeNull();
    // Malformed block is preserved so the user still sees "something is here".
    expect(out.stripped).toContain('<handoff>');
  });

  it('handles null/empty input safely', () => {
    expect(extractCoordinationBlocks('')).toEqual({ stripped: '', handoff: null, delegate: null });
    expect(extractCoordinationBlocks(null).stripped).toBe('');
  });
});
