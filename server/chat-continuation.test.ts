import { describe, it, expect } from 'vitest';
import {
  AUTO_CONTINUATION_MAX_RETRIES,
  AUTO_CONTINUATION_PROMPT,
  clipUtf8StringToMaxBytes,
  detectReActBlock,
  mergePendingContextWithCap,
  parseReActBlock,
  planAutoContinuationRetry,
  stripAssistantControlBlocks,
  utf8SuffixMaxBytes,
} from './chat.js';
import { MAX_AGENTHUB_CONTROL_BLOCK_JSON_BYTES } from './wiki-rag.js';

describe('AUTO_CONTINUATION_PROMPT', () => {
  it('uses a copy-paste-safe ReAct JSON example (no invalid actions:[...] shorthand)', () => {
    expect(AUTO_CONTINUATION_PROMPT).not.toContain('{"actions":[...]}');
    expect(AUTO_CONTINUATION_PROMPT).toContain(
      '{"actions":[{"tool":"wiki","query":"kanban api"}]}',
    );
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
