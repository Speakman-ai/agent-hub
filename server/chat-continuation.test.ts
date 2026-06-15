import { describe, it, expect } from 'vitest';
import {
  AUTO_CONTINUATION_MAX_RETRIES,
  AUTO_CONTINUATION_PROMPT,
  buildGrokHeadlessPrompt,
  buildAutoContinuationPrompt,
  clipUtf8StringToMaxBytes,
  detectReActBlock,
  mergePendingContextWithCap,
  parseReActBlock,
  planAutoContinuationRetry,
  stripAssistantControlBlocks,
  utf8SuffixMaxBytes,
} from './chat.js';
import { MAX_AGENTHUB_CONTROL_BLOCK_JSON_BYTES } from './agenthub-control-limits.js';

describe('buildGrokHeadlessPrompt', () => {
  it('does not prepend the enriched prompt again on history-bootstrap turns', () => {
    const out = buildGrokHeadlessPrompt({
      enrichedPrompt: 'SYSTEM INSTRUCTIONS',
      finalPrompt: 'Previous conversation:\nHuman: hello\n\nHuman: continue',
      needsHistoryBootstrap: true,
      forceSystemPromptThisTurn: false,
    });

    expect(out).toBe('Previous conversation:\nHuman: hello\n\nHuman: continue');
    expect(out).not.toContain('SYSTEM INSTRUCTIONS');
  });

  it('reinjects the enriched prompt when a pending skill forces it', () => {
    const out = buildGrokHeadlessPrompt({
      enrichedPrompt: 'SYSTEM INSTRUCTIONS\n\n## Loaded Skill: test',
      finalPrompt: 'Previous conversation:\nHuman: hello\n\nHuman: use the skill',
      needsHistoryBootstrap: true,
      forceSystemPromptThisTurn: true,
    });

    expect(out).toContain('SYSTEM INSTRUCTIONS');
    expect(out).toContain('## Loaded Skill: test');
    expect(out).toContain('Previous conversation:');
  });
});

describe('buildAutoContinuationPrompt', () => {
  it('matches AUTO_CONTINUATION_PROMPT when browser tools are enabled', () => {
    expect(buildAutoContinuationPrompt(true)).toBe(AUTO_CONTINUATION_PROMPT);
  });

  it('omits browser-specific guidance when browser tools are disabled', () => {
    const p = buildAutoContinuationPrompt(false);
    expect(p).not.toContain('"tool":"browser"');
    expect(p).not.toContain('skill, web, or browser');
    expect(p).toContain('browser tools are disabled');
  });
});

describe('AUTO_CONTINUATION_PROMPT', () => {
  it('uses a copy-paste-safe ReAct JSON example (no invalid actions:[...] shorthand)', () => {
    expect(AUTO_CONTINUATION_PROMPT).not.toContain('{"actions":[...]}');
    expect(AUTO_CONTINUATION_PROMPT).toContain(
      '{"actions":[{"tool":"wiki","query":"kanban api"}]}',
    );
    expect(AUTO_CONTINUATION_PROMPT).toContain('skill, web, or browser');
    expect(AUTO_CONTINUATION_PROMPT).toContain('"tool":"browser"');
  });
});

describe('stripAssistantControlBlocks', () => {
  it('removes agenthub skill/wiki blocks from assistant-visible text', () => {
    const input = [
      'Here is the answer.',
      '<agenthub:react>{"actions":[{"tool":"wiki","query":"board api"}]}</agenthub:react>',
      '<agenthub:skill>{"name":"kanban"}</agenthub:skill>',
      '<agenthub:wiki>{"query":"board api"}</agenthub:wiki>',
      'Final line.',
    ].join('\n');
    const out = stripAssistantControlBlocks(input);
    expect(out).toContain('Here is the answer.');
    expect(out).toContain('Final line.');
    expect(out).not.toContain('<agenthub:react>');
    expect(out).not.toContain('<agenthub:skill>');
    expect(out).not.toContain('<agenthub:wiki>');
  });

  it('removes agenthub task-state blocks', () => {
    const input = `Done.

<agenthub:task-state>
{"goal":"next"}
</agenthub:task-state>`;
    const out = stripAssistantControlBlocks(input);
    expect(out).toContain('Done.');
    expect(out).not.toContain('task-state');
  });

  it('removes a fenced <agenthub:skill> block (persisted message shape)', () => {
    const input = [
      'Answer complete.',
      '',
      '```',
      '<agenthub:skill>{"name":"kanban","reason":"cards"}',
      '</agenthub:skill>',
      '```',
    ].join('\n');
    const out = stripAssistantControlBlocks(input);
    expect(out).toContain('Answer complete.');
    expect(out).not.toContain('<agenthub:skill>');
    expect(out).not.toContain('```');
  });

  it('removes a tilde-fenced <agenthub:skill> block', () => {
    const input = [
      'Done.',
      '~~~',
      '<agenthub:skill>{"name":"wiki-search"}</agenthub:skill>',
      '~~~',
    ].join('\n');
    const out = stripAssistantControlBlocks(input);
    expect(out).toContain('Done.');
    expect(out).not.toContain('<agenthub:skill>');
    expect(out).not.toContain('~~~');
  });

  // [[STEP:*]] markers — the parser extracts these from finalized assistant
  // events, but partial deltas, crashed sessions (fallback to partialFallback),
  // and legacy persisted messages can still carry raw markers. The shared
  // strip util is the last line of defense; without these tests the renderer
  // and persisted message body show literal `[[STEP:...]]` text.
  describe('[[STEP:*]] progress markers', () => {
    it('strips a single started marker from the rendered text', () => {
      const out = stripAssistantControlBlocks(
        'Working on PR review.\n[[STEP:started:Gather PR context]]\nReading diff…',
      );
      expect(out).toContain('Working on PR review.');
      expect(out).toContain('Reading diff');
      expect(out).not.toMatch(/\[\[STEP:/);
    });

    it('strips all three status variants and is case-insensitive', () => {
      const input = [
        'A',
        '[[STEP:started:Gather]]',
        '[[STEP:completed:Gather]]',
        '[[STEP:failed:Post]]',
        '[[step:Started:Lowercase tag]]',
        'B',
      ].join('\n');
      const out = stripAssistantControlBlocks(input);
      expect(out).not.toMatch(/\[\[step:/i);
      expect(out).toContain('A');
      expect(out).toContain('B');
    });

    it('tolerates whitespace around the colons (matches STEP_MARKER_RE)', () => {
      const out = stripAssistantControlBlocks('x [[STEP: started : Foo bar baz ]] y');
      expect(out).not.toMatch(/\[\[STEP:/);
      expect(out).toContain('x');
      expect(out).toContain('y');
    });

    it('leaves malformed markers alone (matches parser behavior)', () => {
      // No closing brackets — must NOT be stripped (matches the parser's
      // tolerance contract). Otherwise a runaway regex could swallow prose.
      const out = stripAssistantControlBlocks('Note [[STEP:started:Foo without close');
      expect(out).toContain('[[STEP:started:Foo without close');
    });

    it('collapses blank-line runs left behind by marker removal', () => {
      const input = ['Line A.', '', '[[STEP:started:Foo]]', '', 'Line B.'].join('\n');
      const out = stripAssistantControlBlocks(input);
      // A blank-line run between A and B is preserved as a single blank
      // line; what we care about is no triple-newline gap and no marker.
      expect(out).not.toMatch(/\[\[STEP:/);
      expect(out).not.toMatch(/\n{3,}/);
      expect(out).toContain('Line A.');
      expect(out).toContain('Line B.');
    });

    it('strips markers alongside <agenthub:*> blocks in one pass', () => {
      const input = [
        'Working.',
        '[[STEP:started:Lookup wiki]]',
        '<agenthub:react>{"actions":[{"tool":"wiki","query":"x"}]}</agenthub:react>',
        '[[STEP:completed:Lookup wiki]]',
        'Done.',
      ].join('\n');
      const out = stripAssistantControlBlocks(input);
      expect(out).not.toMatch(/\[\[STEP:/);
      expect(out).not.toContain('<agenthub:react>');
      expect(out).toContain('Working.');
      expect(out).toContain('Done.');
    });
  });
});

describe('ReAct block parse', () => {
  it('detects and parses a valid react block', () => {
    const input =
      '<agenthub:react>{"actions":[{"tool":"wiki","query":"docs"},{"tool":"skill","name":"kanban"},{"tool":"web","query":"node lts"}]}</agenthub:react>';
    const raw = detectReActBlock(input);
    expect(raw).not.toBeNull();
    const parsed = parseReActBlock(raw!);
    if ('error' in parsed) throw new Error(parsed.detail);
    expect(parsed.actions).toEqual([
      { tool: 'wiki', query: 'docs' },
      { tool: 'skill', name: 'kanban' },
      { tool: 'web', query: 'node lts' },
    ]);
  });

  it('rejects malformed payload', () => {
    const parsed = parseReActBlock(
      '<agenthub:react>{"actions":[{"tool":"oops"}]}</agenthub:react>',
    );
    expect(parsed).toMatchObject({ error: 'malformed' });
  });

  it('rejects web action with empty or whitespace-only query', () => {
    const empty = parseReActBlock(
      '<agenthub:react>{"actions":[{"tool":"web","query":""}]}</agenthub:react>',
    );
    expect(empty).toMatchObject({ error: 'malformed' });
    if ('error' in empty) {
      expect(empty.detail).toMatch(/web action requires non-empty query/);
    }

    const blankPayload = JSON.stringify({ actions: [{ tool: 'web', query: '  \t  ' }] });
    const blank = parseReActBlock(`<agenthub:react>${blankPayload}</agenthub:react>`);
    expect(blank).toMatchObject({ error: 'malformed' });
  });

  it('rejects web action when query field is missing', () => {
    const parsed = parseReActBlock('<agenthub:react>{"actions":[{"tool":"web"}]}</agenthub:react>');
    expect(parsed).toMatchObject({ error: 'malformed' });
    if ('error' in parsed) {
      expect(parsed.detail).toMatch(/web action requires non-empty query/);
    }
  });

  it('rejects react block JSON over the UTF-8 byte cap', () => {
    const q = 'a'.repeat(MAX_AGENTHUB_CONTROL_BLOCK_JSON_BYTES + 500);
    const payload = JSON.stringify({ actions: [{ tool: 'wiki', query: q }] });
    const parsed = parseReActBlock(`<agenthub:react>${payload}</agenthub:react>`);
    expect(parsed).toMatchObject({ error: 'malformed' });
    if ('error' in parsed) {
      expect(parsed.detail).toMatch(/byte cap/);
    }
  });

  it('rejects actions array longer than host execution cap', () => {
    const actions = Array.from({ length: 13 }, (_, i) => ({
      tool: 'wiki',
      query: `q${i}`,
    }));
    const payload = JSON.stringify({ actions });
    const parsed = parseReActBlock(`<agenthub:react>${payload}</agenthub:react>`);
    expect(parsed).toMatchObject({ error: 'malformed' });
    if ('error' in parsed) {
      expect(parsed.detail).toMatch(/exceeds maximum of 12/);
    }
  });

  // ─── Robustness: action-block parser shape variants ────────────────────
  // Regression coverage for the "action blocks sometimes only print, don't
  // execute" bug. Each of these shapes used to return malformed/invalid-JSON.

  it('tolerates a ```json ... ``` fence wrapping the JSON inside the tag', () => {
    const text =
      '<agenthub:react>\n```json\n{"actions":[{"tool":"wiki","query":"kanban"}]}\n```\n</agenthub:react>';
    const parsed = parseReActBlock(text);
    expect(parsed).not.toMatchObject({ error: 'malformed' });
    if (!('error' in parsed)) {
      expect(parsed.actions).toEqual([{ tool: 'wiki', query: 'kanban' }]);
    }
  });

  it('tolerates lead-in prose before the JSON object', () => {
    const text =
      '<agenthub:react>\nNeed to look up wiki:\n{"actions":[{"tool":"wiki","query":"handoff"}]}\n</agenthub:react>';
    const parsed = parseReActBlock(text);
    expect(parsed).not.toMatchObject({ error: 'malformed' });
  });

  it('tolerates raw newlines inside string values (multi-line query)', () => {
    const text =
      '<agenthub:react>{"actions":[{"tool":"wiki","query":"kanban\nstreaming\nparity"}]}</agenthub:react>';
    const parsed = parseReActBlock(text);
    expect(parsed).not.toMatchObject({ error: 'malformed' });
    if (!('error' in parsed)) {
      expect(parsed.actions[0]).toEqual({ tool: 'wiki', query: 'kanban\nstreaming\nparity' });
    }
  });

  it('parses browser navigate actions', () => {
    const text =
      '<agenthub:react>{"actions":[{"tool":"browser","op":"navigate","url":"https://example.com"}]}</agenthub:react>';
    const parsed = parseReActBlock(text);
    expect(parsed).not.toMatchObject({ error: 'malformed' });
    if (!('error' in parsed)) {
      expect(parsed.actions).toEqual([
        { tool: 'browser', op: 'navigate', url: 'https://example.com' },
      ]);
    }
  });

  it('maps selector_or_description to target for browser click', () => {
    const payload = JSON.stringify({
      actions: [{ tool: 'browser', op: 'click', selector_or_description: '#submit' }],
    });
    const parsed = parseReActBlock(`<agenthub:react>${payload}</agenthub:react>`);
    expect(parsed).not.toMatchObject({ error: 'malformed' });
    if (!('error' in parsed)) {
      expect(parsed.actions[0]).toMatchObject({
        tool: 'browser',
        op: 'click',
        target: '#submit',
      });
    }
  });

  it('rejects browser extract with schema but no instruction', () => {
    const payload = JSON.stringify({
      actions: [
        {
          tool: 'browser',
          op: 'extract',
          schema: { type: 'object', properties: { title: { type: 'string' } } },
        },
      ],
    });
    const parsed = parseReActBlock(`<agenthub:react>${payload}</agenthub:react>`);
    expect(parsed).toMatchObject({ error: 'malformed' });
    if ('error' in parsed) {
      expect(parsed.detail).toMatch(/extract with schema requires instruction/);
    }
  });
});

describe('UTF-8 safe clipping', () => {
  it('clipUtf8StringToMaxBytes does not produce replacement characters mid-string', () => {
    const snowman = '\u2603';
    const s = snowman.repeat(20);
    const clipped = clipUtf8StringToMaxBytes(s, 7);
    expect(clipped.length).toBeGreaterThan(0);
    expect(clipped).not.toContain('\uFFFD');
    expect(Buffer.byteLength(clipped, 'utf-8')).toBeLessThanOrEqual(7);
  });

  it('utf8SuffixMaxBytes aligns to character boundaries', () => {
    const s = '\u2603'.repeat(10);
    const suffix = utf8SuffixMaxBytes(s, 7);
    expect(suffix).not.toContain('\uFFFD');
    expect(Buffer.byteLength(suffix, 'utf-8')).toBeLessThanOrEqual(7);
  });
});

describe('mergePendingContextWithCap', () => {
  it('appends when within cap', () => {
    const out = mergePendingContextWithCap('A', 'B', 100);
    expect(out).toBe('A\n\nB');
  });

  it('caps context size and keeps newest addition', () => {
    const existing = 'X'.repeat(200);
    const addition = 'Y'.repeat(120);
    const out = mergePendingContextWithCap(existing, addition, 160);
    expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(160);
    expect(out).toContain('[Truncated: pending context byte cap reached]');
    expect(out).toContain('Y');
  });

  it('handles oversize addition by clipping addition itself', () => {
    const addition = 'Z'.repeat(400);
    const out = mergePendingContextWithCap('', addition, 120);
    expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(120);
    expect(out).toContain('[Truncated: pending context byte cap reached]');
  });

  it('keeps merged addition when existing tail is multibyte-heavy', () => {
    const snowman = '\u2603';
    const existing = snowman.repeat(40);
    const addition = 'NEW_TAIL_MARKER';
    const cap =
      Buffer.byteLength(addition, 'utf-8') +
      Buffer.byteLength('\n\n', 'utf-8') +
      snowman.length * 6 +
      80;
    const out = mergePendingContextWithCap(existing, addition, cap);
    expect(out).toContain('NEW_TAIL_MARKER');
    expect(out).not.toContain('\uFFFD');
  });
});

describe('planAutoContinuationRetry', () => {
  it('schedules the next retry when under the cap', () => {
    const plan = planAutoContinuationRetry({ retries: 0 });
    expect(plan).toEqual({ action: 'retry', nextRetry: 1 });
  });

  it('increments the retry counter monotonically', () => {
    for (let r = 0; r < AUTO_CONTINUATION_MAX_RETRIES; r++) {
      const plan = planAutoContinuationRetry({ retries: r });
      expect(plan).toEqual({ action: 'retry', nextRetry: r + 1 });
    }
  });

  it('drops the continuation once retries reach the cap', () => {
    const plan = planAutoContinuationRetry({ retries: AUTO_CONTINUATION_MAX_RETRIES });
    expect(plan).toEqual({ action: 'drop', reason: 'retries-exhausted' });
  });

  it('drops when retries are already over the cap (defensive)', () => {
    const plan = planAutoContinuationRetry({ retries: AUTO_CONTINUATION_MAX_RETRIES + 5 });
    expect(plan.action).toBe('drop');
  });

  it('honors a caller-provided maxRetries override', () => {
    expect(planAutoContinuationRetry({ retries: 2, maxRetries: 3 })).toEqual({
      action: 'retry',
      nextRetry: 3,
    });
    expect(planAutoContinuationRetry({ retries: 3, maxRetries: 3 })).toEqual({
      action: 'drop',
      reason: 'retries-exhausted',
    });
  });

  it('clamps negative / non-finite retry counters to zero', () => {
    expect(planAutoContinuationRetry({ retries: -1 })).toEqual({
      action: 'retry',
      nextRetry: 1,
    });
    expect(planAutoContinuationRetry({ retries: Number.NaN })).toEqual({
      action: 'retry',
      nextRetry: 1,
    });
  });
});

describe('ReAct block parse — preview tool', () => {
  it('parses observe ops with defaults and tail clamping to integer', () => {
    const payload = JSON.stringify({
      actions: [
        { tool: 'preview', op: 'state' },
        { tool: 'preview', op: 'logs', tail: 50.9 },
      ],
    });
    const parsed = parseReActBlock(`<agenthub:react>${payload}</agenthub:react>`);
    if ('error' in parsed) throw new Error(parsed.detail);
    expect(parsed.actions[0]).toMatchObject({ tool: 'preview', op: 'state' });
    expect(parsed.actions[1]).toMatchObject({ tool: 'preview', op: 'logs', tail: 50 });
  });

  it('parses drive ops and normalizes op case', () => {
    const payload = JSON.stringify({
      actions: [
        { tool: 'preview', op: 'Navigate', route: '/settings' },
        { tool: 'preview', op: 'click', target: 'the save button' },
        { tool: 'preview', op: 'type', target: '#email', text: 'a@b.c' },
        { tool: 'preview', op: 'screenshot' },
      ],
    });
    const parsed = parseReActBlock(`<agenthub:react>${payload}</agenthub:react>`);
    if ('error' in parsed) throw new Error(parsed.detail);
    expect(parsed.actions.map((a) => a.op)).toEqual(['navigate', 'click', 'type', 'screenshot']);
    expect(parsed.actions[0]).toMatchObject({ route: '/settings' });
  });

  it('rejects unsupported preview ops — including lifecycle verbs', () => {
    for (const op of ['start', 'stop', 'restart', 'boot']) {
      const parsed = parseReActBlock(
        `<agenthub:react>{"actions":[{"tool":"preview","op":"${op}"}]}</agenthub:react>`,
      );
      expect(parsed).toMatchObject({ error: 'malformed' });
      if ('error' in parsed) {
        expect(parsed.detail).toMatch(/supported preview operation/);
      }
    }
  });

  it('rejects navigate without a route or with a full URL', () => {
    const missing = parseReActBlock(
      '<agenthub:react>{"actions":[{"tool":"preview","op":"navigate"}]}</agenthub:react>',
    );
    expect(missing).toMatchObject({ error: 'malformed' });

    const fullUrl = parseReActBlock(
      '<agenthub:react>{"actions":[{"tool":"preview","op":"navigate","route":"https://example.com"}]}</agenthub:react>',
    );
    expect(fullUrl).toMatchObject({ error: 'malformed' });
    if ('error' in fullUrl) {
      expect(fullUrl.detail).toMatch(/route starting with "\/"/);
    }
  });

  it('rejects click/type without operands', () => {
    const click = parseReActBlock(
      '<agenthub:react>{"actions":[{"tool":"preview","op":"click"}]}</agenthub:react>',
    );
    expect(click).toMatchObject({ error: 'malformed' });

    const type = parseReActBlock(
      '<agenthub:react>{"actions":[{"tool":"preview","op":"type","target":"#x"}]}</agenthub:react>',
    );
    expect(type).toMatchObject({ error: 'malformed' });
    if ('error' in type) {
      expect(type.detail).toMatch(/preview type requires text/);
    }
  });
});
