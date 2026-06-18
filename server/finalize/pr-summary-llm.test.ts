import { describe, it, expect, vi } from 'vitest';
import {
  buildPrSummaryInput,
  generateLlmPrSummary,
  parsePrSummaryResponse,
} from './pr-summary-llm.js';

describe('parsePrSummaryResponse', () => {
  it('parses a clean JSON object', () => {
    const out = parsePrSummaryResponse('{"title":"Add export button","summary":"Wires it up."}');
    expect(out).toEqual({ title: 'Add export button', summary: 'Wires it up.' });
  });

  it('tolerates a ```json fence and surrounding prose', () => {
    const raw =
      'Here you go:\n```json\n{"title":"Fix login","summary":"Repairs OAuth."}\n```\nDone.';
    expect(parsePrSummaryResponse(raw)).toEqual({ title: 'Fix login', summary: 'Repairs OAuth.' });
  });

  it('strips surrounding quotes and trailing punctuation from the title', () => {
    const out = parsePrSummaryResponse('{"title":"\\"Fix the thing.\\"","summary":"x"}');
    expect(out?.title).toBe('Fix the thing');
  });

  it('truncates an over-long title to <= 70 chars with an ellipsis', () => {
    const longTitle = 'Add '.repeat(30).trim();
    const out = parsePrSummaryResponse(JSON.stringify({ title: longTitle, summary: 's' }));
    expect(out?.title.length).toBeLessThanOrEqual(70);
    expect(out?.title.endsWith('…')).toBe(true);
  });

  it('returns null when there is no title', () => {
    expect(parsePrSummaryResponse('{"summary":"only a summary"}')).toBeNull();
    expect(parsePrSummaryResponse('{"title":"","summary":"x"}')).toBeNull();
  });

  it('returns null on malformed / non-JSON input', () => {
    expect(parsePrSummaryResponse('not json at all')).toBeNull();
    expect(parsePrSummaryResponse('')).toBeNull();
    expect(parsePrSummaryResponse('{ broken')).toBeNull();
  });
});

describe('buildPrSummaryInput', () => {
  it('includes card context, every commit (subject + body), and the diff stat', () => {
    const input = buildPrSummaryInput({
      cardTitle: 'Vague title',
      cardDescription: 'The original ask.',
      commits: [{ subject: 'feat: A', body: 'why A' }, { subject: 'fix: B' }],
      diffStat: 'src/a.ts | 3 +-',
    });
    expect(input).toContain('Task title: Vague title');
    expect(input).toContain('The original ask.');
    expect(input).toContain('- feat: A');
    expect(input).toContain('why A');
    expect(input).toContain('- fix: B');
    expect(input).toContain('src/a.ts | 3 +-');
  });

  it('drops empty/whitespace commit subjects', () => {
    const input = buildPrSummaryInput({
      commits: [{ subject: '   ' }, { subject: 'real commit' }],
    });
    expect(input).toContain('- real commit');
    expect(input).not.toMatch(/-\s*\n/);
  });
});

describe('generateLlmPrSummary', () => {
  const commits = [{ subject: 'feat: ship X' }, { subject: 'fix: address review' }];

  it('returns null when no API key is configured (no fetch call)', async () => {
    const fetchImpl = vi.fn();
    const out = await generateLlmPrSummary({ commits, fetchImpl: fetchImpl as never });
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('calls OpenAI and parses the JSON response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"title":"Ship X","summary":"Adds X end to end."}' } }],
      }),
    });
    const out = await generateLlmPrSummary({
      commits,
      diffStat: 'a | 1 +',
      openaiApiKey: 'sk-test',
      fetchImpl: fetchImpl as never,
    });
    expect(out).toEqual({ title: 'Ship X', summary: 'Adds X end to end.' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe(
      'Bearer sk-test',
    );
  });

  it('prefers Anthropic when both keys are present', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '{"title":"Ship X","summary":"y"}' }],
      }),
    });
    const out = await generateLlmPrSummary({
      commits,
      anthropicApiKey: 'ak-test',
      openaiApiKey: 'sk-test',
      fetchImpl: fetchImpl as never,
    });
    expect(out).toEqual({ title: 'Ship X', summary: 'y' });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
  });

  it('returns null on a non-ok HTTP response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    const out = await generateLlmPrSummary({
      commits,
      openaiApiKey: 'sk-test',
      fetchImpl: fetchImpl as never,
    });
    expect(out).toBeNull();
  });

  it('returns null (never throws) when fetch rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const out = await generateLlmPrSummary({
      commits,
      openaiApiKey: 'sk-test',
      fetchImpl: fetchImpl as never,
    });
    expect(out).toBeNull();
  });

  it('returns null when the model emits unparseable text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'sorry, I cannot do that' } }] }),
    });
    const out = await generateLlmPrSummary({
      commits,
      openaiApiKey: 'sk-test',
      fetchImpl: fetchImpl as never,
    });
    expect(out).toBeNull();
  });
});
