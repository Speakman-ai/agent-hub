import { describe, it, expect } from 'vitest';
import {
  extractJsonFromTagBody,
  stripOuterMarkdownFence,
  stripBlockquotePrefix,
  sliceFirstBalancedJson,
  normalizeControlCharsInsideStrings,
  parseTagBodyAsJson,
  stripFencedCodeBlockBodies,
  detectTagBlockInLastFence,
} from './action-block-parsing.js';
import { detectCloseCardBlock } from './card-auto-close.js';
import { detectSkillBlock, parseSkillBlock } from './skill-invoke.js';
import { detectReActBlock, parseReActBlock } from './chat.js';
import { detectWikiRequestBlock } from './wiki-rag.js';

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

// ─── stripBlockquotePrefix ──────────────────────────────────────────────

describe('stripBlockquotePrefix', () => {
  it('strips a `> ` prefix from every non-blank line', () => {
    expect(stripBlockquotePrefix('> {"a":1,\n> "b":2}')).toBe('{"a":1,\n"b":2}');
  });

  it('strips a `>` prefix without a trailing space', () => {
    expect(stripBlockquotePrefix('>line one\n>line two')).toBe('line one\nline two');
  });

  it('tolerates blank lines without a prefix', () => {
    expect(stripBlockquotePrefix('> {"a":1,\n\n> "b":2}')).toBe('{"a":1,\n\n"b":2}');
  });

  it('returns the body unchanged when only some lines carry the prefix', () => {
    // A blockquote that's not uniform isn't a blockquote — leave it alone so
    // we don't mangle a JSON string that happens to contain `>` mid-body.
    const body = '> {"a":1,\nnot-quoted line\n> "b":2}';
    expect(stripBlockquotePrefix(body)).toBe(body);
  });

  it('returns the body unchanged when no line carries the prefix', () => {
    expect(stripBlockquotePrefix('{"a":1}')).toBe('{"a":1}');
  });

  it('handles indented blockquote markers (whitespace before `>`)', () => {
    expect(stripBlockquotePrefix('  > {"a":1,\n  > "b":2}')).toBe('{"a":1,\n"b":2}');
  });
});

describe('extractJsonFromTagBody — blockquote tolerance', () => {
  it('parses a body wrapped in a markdown blockquote', () => {
    const body = '> {"toAgent":"hub-backend","note":"hi"}';
    const out = extractJsonFromTagBody(body);
    expect(JSON.parse(out!)).toEqual({ toAgent: 'hub-backend', note: 'hi' });
  });

  it('parses a multi-line blockquoted body', () => {
    const body = '> {"toAgent":"hub-backend",\n> "note":"hi"}';
    const out = extractJsonFromTagBody(body);
    expect(JSON.parse(out!)).toEqual({ toAgent: 'hub-backend', note: 'hi' });
  });

  it('parses blockquote + inner code fence + JSON in one go', () => {
    const body = '> ```json\n> {"toAgent":"hub-backend","note":"hi"}\n> ```';
    const out = extractJsonFromTagBody(body);
    expect(JSON.parse(out!)).toEqual({ toAgent: 'hub-backend', note: 'hi' });
  });
});

// ─── End-to-end coverage across every action-block detector ────────────────
//
// Each detector funnels its raw body through `extractJsonFromTagBody`, so a
// regression in any of the layered tolerances above can silently break a
// real action block. These tests pin down the wrapper shapes the parser is
// expected to swallow per detector — failing here means the user's
// `<delegate>` / `<handoff>` / `<agenthub:close-card>` / `<agenthub:skill>` /
// `<agenthub:react>` block stops triggering the host action and just renders
// as plain text.

describe('detectCloseCardBlock — wrapper-shape tolerance', () => {
  const valid = '{"reason":"duplicate","note":"x"}';

  it('parses an inner ```json code fence', () => {
    const text = `<agenthub:close-card>\n\`\`\`json\n${valid}\n\`\`\`\n</agenthub:close-card>`;
    const r = detectCloseCardBlock(text);
    expect(r.task).not.toBeNull();
    expect(r.task!.reason).toBe('duplicate');
  });

  it('parses an inner unlabeled ``` code fence', () => {
    const text = `<agenthub:close-card>\n\`\`\`\n${valid}\n\`\`\`\n</agenthub:close-card>`;
    const r = detectCloseCardBlock(text);
    expect(r.task).not.toBeNull();
  });

  it('parses with prose between the tag and the JSON', () => {
    const text = `<agenthub:close-card>\nHere is the close-card payload:\n${valid}\n</agenthub:close-card>`;
    const r = detectCloseCardBlock(text);
    expect(r.task).not.toBeNull();
  });

  it('parses with a blockquote prefix on every line', () => {
    const text = `<agenthub:close-card>\n> ${valid}\n</agenthub:close-card>`;
    const r = detectCloseCardBlock(text);
    expect(r.task).not.toBeNull();
  });

  it('still surfaces invalid-json on truly broken bodies', () => {
    const text = `<agenthub:close-card>\nthis isn't json\n</agenthub:close-card>`;
    const r = detectCloseCardBlock(text);
    expect(r.task).toBeNull();
    expect(r.reason).toBe('invalid-json');
  });
});

describe('parseSkillBlock — wrapper-shape tolerance', () => {
  it('parses an inner ```json code fence', () => {
    const text = '<agenthub:skill>\n```json\n{"name":"kanban"}\n```\n</agenthub:skill>';
    const r = parseSkillBlock(text);
    expect('error' in r).toBe(false);
    if (!('error' in r)) expect(r.name).toBe('kanban');
  });

  it('parses with prose preamble', () => {
    const text =
      '<agenthub:skill>\nLoading the kanban skill:\n{"name":"kanban"}\n</agenthub:skill>';
    const r = parseSkillBlock(text);
    expect('error' in r).toBe(false);
  });

  it('parses with a blockquote prefix on every line', () => {
    const text = '<agenthub:skill>\n> {"name":"kanban"}\n</agenthub:skill>';
    const r = parseSkillBlock(text);
    expect('error' in r).toBe(false);
  });
});

describe('parseReActBlock — wrapper-shape tolerance', () => {
  it('parses an inner ```json code fence around actions', () => {
    const text =
      '<agenthub:react>\n```json\n{"actions":[{"tool":"wiki","query":"foo"}]}\n```\n</agenthub:react>';
    const r = parseReActBlock(text);
    expect('error' in r).toBe(false);
    if (!('error' in r)) expect(r.actions.length).toBe(1);
  });

  it('parses with prose preamble', () => {
    const text =
      '<agenthub:react>\nQuerying wiki:\n{"actions":[{"tool":"wiki","query":"foo"}]}\n</agenthub:react>';
    const r = parseReActBlock(text);
    expect('error' in r).toBe(false);
  });

  it('parses with a blockquote prefix on every line', () => {
    const text =
      '<agenthub:react>\n> {"actions":[{"tool":"wiki","query":"foo"}]}\n</agenthub:react>';
    const r = parseReActBlock(text);
    expect('error' in r).toBe(false);
  });
});

// ─── stripFencedCodeBlockBodies ─────────────────────────────────────────

describe('stripFencedCodeBlockBodies', () => {
  it('returns non-string input unchanged', () => {
    expect(stripFencedCodeBlockBodies('' as string)).toBe('');
    expect(stripFencedCodeBlockBodies(undefined as unknown as string)).toBe(
      undefined as unknown as string,
    );
  });

  it('returns input unchanged when there are no fence characters', () => {
    expect(stripFencedCodeBlockBodies('hello world')).toBe('hello world');
    expect(stripFencedCodeBlockBodies('<agenthub:skill>{"name":"x"}</agenthub:skill>')).toBe(
      '<agenthub:skill>{"name":"x"}</agenthub:skill>',
    );
  });

  it('blanks the body of a triple-backtick fenced block', () => {
    const text = [
      'before',
      '```',
      '<agenthub:skill>{"name":"x"}</agenthub:skill>',
      '```',
      'after',
    ].join('\n');
    const out = stripFencedCodeBlockBodies(text);
    expect(out).toContain('before');
    expect(out).toContain('after');
    // Opener and closer kept; body line blanked.
    expect(out).toContain('```');
    expect(out).not.toContain('<agenthub:skill>');
  });

  it('blanks the body of a triple-tilde fenced block', () => {
    const text = ['~~~', '<agenthub:react>{"actions":[]}</agenthub:react>', '~~~'].join('\n');
    const out = stripFencedCodeBlockBodies(text);
    expect(out).toContain('~~~');
    expect(out).not.toContain('<agenthub:react>');
  });

  it('handles fenced blocks with a language hint on the opener', () => {
    const text = ['```json', '<agenthub:wiki>{"query":"x"}</agenthub:wiki>', '```'].join('\n');
    const out = stripFencedCodeBlockBodies(text);
    expect(out).not.toContain('<agenthub:wiki>');
  });

  it('only treats a fence character as a closer when length matches or exceeds opener', () => {
    // Opener uses 4 backticks; a 3-backtick line is NOT a valid closer.
    const text = [
      '````',
      'inside still <agenthub:skill>{"name":"x"}</agenthub:skill>',
      '```',
      'still inside',
      '````',
    ].join('\n');
    const out = stripFencedCodeBlockBodies(text);
    expect(out).not.toContain('<agenthub:skill>');
    expect(out).not.toContain('still inside');
  });

  it('does not strip across non-matching fence characters', () => {
    // ``` opens, ~~~ does NOT close it.
    const text = [
      '```',
      '<agenthub:skill>{"name":"x"}</agenthub:skill>',
      '~~~',
      'still fenced',
      '```',
    ].join('\n');
    const out = stripFencedCodeBlockBodies(text);
    expect(out).not.toContain('<agenthub:skill>');
    expect(out).not.toContain('still fenced');
  });

  it('preserves naked top-level tags outside any fence', () => {
    const text = [
      'Use this:',
      '```',
      '<agenthub:skill>{"name":"docs"}</agenthub:skill>',
      '```',
      '<agenthub:skill>{"name":"real"}</agenthub:skill>',
    ].join('\n');
    const out = stripFencedCodeBlockBodies(text);
    expect(out).toContain('<agenthub:skill>{"name":"real"}</agenthub:skill>');
    expect(out).not.toContain('"docs"');
  });
});

// ─── detector code-fence suppression ────────────────────────────────────

describe('detectSkillBlock — fenced examples are NOT detected', () => {
  it('returns null for a skill block that lives only inside a ``` fence', () => {
    const text = [
      'Here is how to invoke it:',
      '```',
      '<agenthub:skill>',
      '{"name":"aws-login","reason":"profile=dev"}',
      '</agenthub:skill>',
      '```',
      'Reply when ready.',
    ].join('\n');
    expect(detectSkillBlock(text)).toBeNull();
  });

  it('still detects a real top-level block when an example fence is also present', () => {
    const text = [
      '```',
      '<agenthub:skill>{"name":"example"}</agenthub:skill>',
      '```',
      '',
      '<agenthub:skill>{"name":"real"}</agenthub:skill>',
    ].join('\n');
    const got = detectSkillBlock(text);
    expect(got).not.toBeNull();
    expect(got).toContain('"real"');
    expect(got).not.toContain('"example"');
  });

  it('detects a skill block inside triple-tilde fences at end of message', () => {
    const text = ['~~~', '<agenthub:skill>{"name":"kanban"}</agenthub:skill>', '~~~'].join('\n');
    const got = detectSkillBlock(text);
    expect(got).not.toBeNull();
    expect(got).toContain('kanban');
  });
});

describe('detectReActBlock — fenced examples are NOT detected', () => {
  it('returns null for a ReAct block in a mid-message fence (content follows)', () => {
    // The fence is NOT at the tail of the message — substantive text follows the
    // closing fence, which is the canonical pattern for a documentation example.
    // The fallback (`detectTagBlockInLastFence`) only fires for fences that end
    // the message, so this correctly returns null.
    const text = [
      'Emit something like:',
      '```',
      '<agenthub:react>{"actions":[{"tool":"wiki","query":"foo"}]}</agenthub:react>',
      '```',
      'The actions array must contain at least one action.',
    ].join('\n');
    expect(detectReActBlock(text)).toBeNull();
  });

  it('still detects a real top-level ReAct block alongside a fenced example', () => {
    const text = [
      '```',
      '<agenthub:react>{"actions":[{"tool":"wiki","query":"example"}]}</agenthub:react>',
      '```',
      '<agenthub:react>{"actions":[{"tool":"wiki","query":"real"}]}</agenthub:react>',
    ].join('\n');
    const got = detectReActBlock(text);
    expect(got).not.toBeNull();
    expect(got).toContain('"real"');
  });
});

describe('detectWikiRequestBlock — fenced examples are NOT detected', () => {
  it('returns null for a wiki block quoted inside a fence', () => {
    const text = [
      'Try:',
      '```',
      '<agenthub:wiki>{"query":"deployment"}</agenthub:wiki>',
      '```',
    ].join('\n');
    expect(detectWikiRequestBlock(text)).toBeNull();
  });

  it('still detects a real top-level wiki block alongside a fenced example', () => {
    const text = [
      '```',
      '<agenthub:wiki>{"query":"example"}</agenthub:wiki>',
      '```',
      '<agenthub:wiki>{"query":"real"}</agenthub:wiki>',
    ].join('\n');
    const got = detectWikiRequestBlock(text);
    expect(got).not.toBeNull();
    expect(got).toContain('"real"');
  });
});

// ─── detectTagBlockInLastFence ──────────────────────────────────────────────
//
// Regression suite for the "skill block wrapped in backtick fences" bug:
// agents sometimes follow the documentation example too literally and wrap
// their <agenthub:skill> / <agenthub:react> blocks in triple-backtick fences.
// The primary detectors mask fenced content (to avoid false-positives from
// in-message documentation examples), but `detectTagBlockInLastFence` provides
// a fallback that rescues genuine end-of-turn invocations inside the LAST fence.

describe('detectTagBlockInLastFence', () => {
  it('finds a tag block inside the last fenced code block', () => {
    const text = [
      'Some prose.',
      '```',
      '<agenthub:skill>{"name":"kanban","reason":"need cards"}',
      '</agenthub:skill>',
      '```',
    ].join('\n');
    const got = detectTagBlockInLastFence(text, 'agenthub:skill');
    expect(got).not.toBeNull();
    expect(got).toContain('kanban');
  });

  it('returns null when the tag only appears in a mid-message fence (not last)', () => {
    // The fence with the skill tag is NOT the last thing — there is substantial
    // prose after it. This is the documentation-example scenario we must NOT detect.
    const text = [
      'Here is how to load a skill:',
      '```',
      '<agenthub:skill>{"name":"example"}</agenthub:skill>',
      '```',
      'After that explanation, here is more content that comes after the fence.',
    ].join('\n');
    const got = detectTagBlockInLastFence(text, 'agenthub:skill');
    expect(got).toBeNull();
  });

  it('returns null when no fenced block exists', () => {
    expect(detectTagBlockInLastFence('hello world', 'agenthub:skill')).toBeNull();
  });

  it('returns null for empty / non-string input', () => {
    expect(detectTagBlockInLastFence('', 'agenthub:skill')).toBeNull();
    expect(detectTagBlockInLastFence(null as unknown as string, 'agenthub:skill')).toBeNull();
  });

  it('works for the agenthub:react tag too', () => {
    const text = [
      'Need wiki context.',
      '```',
      '<agenthub:react>{"actions":[{"tool":"wiki","query":"deployment"}]}</agenthub:react>',
      '```',
    ].join('\n');
    const got = detectTagBlockInLastFence(text, 'agenthub:react');
    expect(got).not.toBeNull();
    expect(got).toContain('deployment');
  });

  it('finds a tag inside the last ~~~ fence at EOF', () => {
    const text = [
      'Loading skill.',
      '~~~json',
      '<agenthub:skill>{"name":"wiki-search","reason":"docs"}',
      '</agenthub:skill>',
      '~~~',
    ].join('\n');
    const got = detectTagBlockInLastFence(text, 'agenthub:skill');
    expect(got).not.toBeNull();
    expect(got).toContain('wiki-search');
  });
});

// ─── detectSkillBlock — in-fence fallback ───────────────────────────────────

describe('detectSkillBlock — in-fence fallback (regression)', () => {
  it('detects a skill block that is wrapped in backtick fences at end of message', () => {
    const text = [
      'I need to check the kanban board.',
      '',
      '```',
      '<agenthub:skill>{"name":"kanban","reason":"need board access"}',
      '</agenthub:skill>',
      '```',
    ].join('\n');
    const got = detectSkillBlock(text);
    expect(got).not.toBeNull();
    expect(got).toContain('kanban');
  });

  it('still detects a naked skill block (primary path unchanged)', () => {
    const text = [
      'Some work done.',
      '',
      '<agenthub:skill>{"name":"kanban","reason":"need cards"}',
      '</agenthub:skill>',
    ].join('\n');
    const got = detectSkillBlock(text);
    expect(got).not.toBeNull();
    expect(got).toContain('kanban');
  });

  it('does NOT detect a skill block in a mid-message fence (docs example)', () => {
    // Block is in a fence, but there is meaningful content after the fence.
    const text = [
      'Here is how to use a skill:',
      '```',
      '<agenthub:skill>{"name":"example"}</agenthub:skill>',
      '```',
      'Use the name field to specify which skill to load.',
    ].join('\n');
    // There IS a naked-looking block in the middle; the surrounding prose
    // before the fence body isn't a naked top-level block, so nothing matches.
    expect(detectSkillBlock(text)).toBeNull();
  });

  it('prefers a naked block over a fenced one when both are present', () => {
    const text = [
      '```',
      '<agenthub:skill>{"name":"docs-example"}</agenthub:skill>',
      '```',
      'Here is the real invocation:',
      '<agenthub:skill>{"name":"real-skill"}</agenthub:skill>',
    ].join('\n');
    const got = detectSkillBlock(text);
    expect(got).not.toBeNull();
    expect(got).toContain('real-skill');
    expect(got).not.toContain('docs-example');
  });
});

// ─── detectReActBlock — in-fence fallback ───────────────────────────────────

describe('detectReActBlock — in-fence fallback (regression)', () => {
  it('detects a react block wrapped in backtick fences at end of message', () => {
    const text = [
      'Let me search the wiki.',
      '',
      '```',
      '<agenthub:react>{"actions":[{"tool":"wiki","query":"deployment guide"}]}</agenthub:react>',
      '```',
    ].join('\n');
    const got = detectReActBlock(text);
    expect(got).not.toBeNull();
    expect(got).toContain('deployment guide');
  });

  it('does NOT detect a react block in a mid-message fence', () => {
    const text = [
      'Here is an example:',
      '```',
      '<agenthub:react>{"actions":[{"tool":"wiki","query":"example"}]}</agenthub:react>',
      '```',
      'The actions array must contain at least one action.',
    ].join('\n');
    expect(detectReActBlock(text)).toBeNull();
  });
});
