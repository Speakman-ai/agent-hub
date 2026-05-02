import { describe, it, expect } from 'vitest';
import {
  extractJsonFromTagBody,
  stripOuterMarkdownFence,
  sliceFirstBalancedJson,
  normalizeControlCharsInsideStrings,
  parseTagBodyAsJson,
} from './action-block-parsing.js';

// ─── extractJsonFromTagBody ─────────────────────────────────────────────

describe('extractJsonFromTagBody', () => {
  it('returns null for non-string input', () => {
    expect(extractJsonFromTagBody(undefined as unknown as string)).toBeNull();
    expect(extractJsonFromTagBody(null as unknown as string)).toBeNull();
    expect(extractJsonFromTagBody(42 as unknown as string)).toBeNull();
  });

  it('returns null for empty / whitespace-only input', () => {
    expect(extractJsonFromTagBody('')).toBeNull();
    expect(extractJsonFromTagBody('   \n\t  ')).toBeNull();
  });

  it('returns clean JSON unchanged after trim', () => {
    const out = extractJsonFromTagBody('  {"toAgent":"hub-backend","note":"hi"}  ');
    expect(out).toBe('{"toAgent":"hub-backend","note":"hi"}');
    expect(JSON.parse(out!)).toEqual({ toAgent: 'hub-backend', note: 'hi' });
  });

  it('strips a surrounding ```json ... ``` fence inside the tag body', () => {
    const body = '```json\n{"toAgent":"hub-backend","note":"hi"}\n```';
    const out = extractJsonFromTagBody(body);
    expect(out).toBe('{"toAgent":"hub-backend","note":"hi"}');
    expect(JSON.parse(out!)).toEqual({ toAgent: 'hub-backend', note: 'hi' });
  });

  it('strips a bare ``` ... ``` fence (no language hint)', () => {
    const body = '```\n{"toAgent":"hub-backend","note":"hi"}\n```';
    const out = extractJsonFromTagBody(body);
    expect(JSON.parse(out!)).toEqual({ toAgent: 'hub-backend', note: 'hi' });
  });

  it('skips prose before the JSON object', () => {
    const body = 'Here\'s the payload:\n{"toAgent":"hub-backend","note":"hi"}';
    const out = extractJsonFromTagBody(body);
    expect(JSON.parse(out!)).toEqual({ toAgent: 'hub-backend', note: 'hi' });
  });

  it('skips prose before AND after the JSON object', () => {
    const body = 'Here\'s the payload:\n{"toAgent":"hub-backend","note":"hi"}\n— that\'s all.';
    const out = extractJsonFromTagBody(body);
    expect(JSON.parse(out!)).toEqual({ toAgent: 'hub-backend', note: 'hi' });
  });

  it('normalizes raw newlines inside JSON string values so JSON.parse accepts them', () => {
    // This is the exact failure mode that prevented the lead's own handoff
    // from this very session — a literal newline inside the `note` string.
    const body = '{"toAgent":"hub-backend","note":"line one\nline two\nline three"}';
    expect(() => JSON.parse(body)).toThrow(); // sanity: JSON.parse rejects raw \n in strings
    const out = extractJsonFromTagBody(body);
    expect(out).not.toBeNull();
    expect(JSON.parse(out!)).toEqual({
      toAgent: 'hub-backend',
      note: 'line one\nline two\nline three',
    });
  });

  it('normalizes raw tabs and CR inside string values', () => {
    const body = '{"a":"col1\tcol2","b":"line1\r\nline2"}';
    expect(() => JSON.parse(body)).toThrow();
    const out = extractJsonFromTagBody(body);
    expect(JSON.parse(out!)).toEqual({ a: 'col1\tcol2', b: 'line1\r\nline2' });
  });

  it('handles a JSON array body (delegate-style)', () => {
    const body = '[{"agentId":"a","task":"t"},{"agentId":"b","task":"t2"}]';
    const out = extractJsonFromTagBody(body);
    expect(JSON.parse(out!)).toEqual([
      { agentId: 'a', task: 't' },
      { agentId: 'b', task: 't2' },
    ]);
  });

  it('handles fenced + prose + raw newlines all combined', () => {
    const body = `Here is the block:
\`\`\`json
{"toAgent":"hub-backend","note":"first line
second line"}
\`\`\`
done.`;
    const out = extractJsonFromTagBody(body);
    expect(out).not.toBeNull();
    expect(JSON.parse(out!)).toEqual({
      toAgent: 'hub-backend',
      note: 'first line\nsecond line',
    });
  });

  it('preserves brace literals inside string values when slicing', () => {
    const body = '{"note":"this {is} not {nested}","x":1}';
    const out = extractJsonFromTagBody(body);
    expect(JSON.parse(out!)).toEqual({ note: 'this {is} not {nested}', x: 1 });
  });

  it('handles escaped quotes inside string values', () => {
    const body = '{"note":"she said \\"hi\\""}';
    const out = extractJsonFromTagBody(body);
    expect(JSON.parse(out!)).toEqual({ note: 'she said "hi"' });
  });

  it('returns null when the body has no JSON opener at all', () => {
    expect(extractJsonFromTagBody('just prose, nothing else')).toBeNull();
    expect(extractJsonFromTagBody('reason=duplicate')).toBeNull();
  });

  it('does not get confused by braces inside string with embedded backslash', () => {
    // A literal backslash followed by something that is NOT a quote.
    const body = '{"note":"path is C:\\\\foo\\\\bar"}';
    const out = extractJsonFromTagBody(body);
    expect(JSON.parse(out!)).toEqual({ note: 'path is C:\\foo\\bar' });
  });

  it('takes only the first balanced JSON value when multiple appear', () => {
    const body = '{"first":1}\nthen\n{"second":2}';
    const out = extractJsonFromTagBody(body);
    expect(JSON.parse(out!)).toEqual({ first: 1 });
  });
});

// ─── stripOuterMarkdownFence ────────────────────────────────────────────

describe('stripOuterMarkdownFence', () => {
  it('strips ```json ... ``` wrapper', () => {
    const body = '```json\n{"a":1}\n```';
    expect(stripOuterMarkdownFence(body)).toBe('{"a":1}');
  });

  it('strips ``` ... ``` wrapper without language hint', () => {
    const body = '```\n{"a":1}\n```';
    expect(stripOuterMarkdownFence(body)).toBe('{"a":1}');
  });

  it('strips a fence with whitespace after the language hint', () => {
    const body = '```json   \n{"a":1}\n```   ';
    expect(stripOuterMarkdownFence(body)).toBe('{"a":1}');
  });

  it('returns body unchanged when no fence is present', () => {
    expect(stripOuterMarkdownFence('{"a":1}')).toBe('{"a":1}');
  });

  it('returns body unchanged for a partial fence (open only)', () => {
    expect(stripOuterMarkdownFence('```json\n{"a":1}')).toBe('```json\n{"a":1}');
  });
});

// ─── sliceFirstBalancedJson ─────────────────────────────────────────────

describe('sliceFirstBalancedJson', () => {
  it('returns the object slice when prose precedes it', () => {
    expect(sliceFirstBalancedJson('hi {"a":1}')).toBe('{"a":1}');
  });

  it('returns the array slice when prose precedes it', () => {
    expect(sliceFirstBalancedJson('here: [1,2,3]')).toBe('[1,2,3]');
  });

  it('handles nested objects', () => {
    expect(sliceFirstBalancedJson('prefix {"a":{"b":1}} suffix')).toBe('{"a":{"b":1}}');
  });

  it('does not count braces inside string values', () => {
    const body = '{"note":"x{y}z"}';
    expect(sliceFirstBalancedJson(body)).toBe(body);
  });

  it('returns null when no opener is present', () => {
    expect(sliceFirstBalancedJson('just text')).toBeNull();
  });

  it('returns the partial slice when the body is unbalanced (no close)', () => {
    expect(sliceFirstBalancedJson('{"a":1')).toBe('{"a":1');
  });
});

// ─── normalizeControlCharsInsideStrings ─────────────────────────────────

describe('normalizeControlCharsInsideStrings', () => {
  it('escapes raw newlines inside string literals', () => {
    const out = normalizeControlCharsInsideStrings('{"a":"line1\nline2"}');
    expect(out).toBe('{"a":"line1\\nline2"}');
    expect(JSON.parse(out)).toEqual({ a: 'line1\nline2' });
  });

  it('leaves newlines outside string literals untouched (they are JSON whitespace)', () => {
    const out = normalizeControlCharsInsideStrings('{\n  "a": 1\n}');
    expect(out).toBe('{\n  "a": 1\n}');
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });

  it('does not double-escape an already-escaped newline', () => {
    const out = normalizeControlCharsInsideStrings('{"a":"line1\\nline2"}');
    expect(out).toBe('{"a":"line1\\nline2"}');
    expect(JSON.parse(out)).toEqual({ a: 'line1\nline2' });
  });

  it('escapes tabs and CR inside strings', () => {
    const out = normalizeControlCharsInsideStrings('{"a":"x\ty\rz"}');
    expect(JSON.parse(out)).toEqual({ a: 'x\ty\rz' });
  });

  it('handles escaped quotes in strings', () => {
    const out = normalizeControlCharsInsideStrings('{"a":"he said \\"hi\\"\nbye"}');
    expect(JSON.parse(out)).toEqual({ a: 'he said "hi"\nbye' });
  });
});

// ─── parseTagBodyAsJson ─────────────────────────────────────────────────

describe('parseTagBodyAsJson', () => {
  it('returns ok=true with parsed value for clean JSON', () => {
    expect(parseTagBodyAsJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('returns ok=true after fence-stripping + newline normalization', () => {
    const body = '```json\n{"note":"line1\nline2"}\n```';
    const result = parseTagBodyAsJson(body);
    expect(result).toEqual({ ok: true, value: { note: 'line1\nline2' } });
  });

  it('returns ok=false when no JSON can be located', () => {
    expect(parseTagBodyAsJson('just prose')).toEqual({ ok: false });
  });

  it('returns ok=false when the slice still fails JSON.parse', () => {
    // Object with a trailing comma — neither slicing nor newline normalization
    // can rescue this; tracker error path.
    expect(parseTagBodyAsJson('{"a":1,}')).toEqual({ ok: false });
  });
});
