import { describe, it, expect, vi } from 'vitest';
import {
  MAX_FOLLOW_UP_STEPS,
  MAX_MANUAL_TESTING_STEPS,
  buildRunSummaryInput,
  generateFinalizeRunSummary,
  parseRunSummaryResponse,
} from './run-summary-llm.js';

function openaiResponse(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
  });
}

describe('buildRunSummaryInput', () => {
  it('includes task, commits, diff stat, and the review history', () => {
    const input = buildRunSummaryInput({
      cardTitle: 'Add widget',
      cardDescription: 'Users need a widget.',
      commits: [{ subject: 'Add widget', body: 'details here' }],
      diffStat: ' 1 file changed, 3 insertions(+)',
      reviewRounds: [
        {
          round: 1,
          verdict: 'changes_requested',
          findings: [{ filePath: 'server/a.ts', lineStart: 4, lineEnd: 9, body: 'guard null' }],
          truncatedFindings: 0,
        },
      ],
    });

    expect(input).toContain('Task title: Add widget');
    expect(input).toContain('Users need a widget.');
    expect(input).toContain('Commits (newest first):');
    expect(input).toContain('details here');
    expect(input).toContain('Changed files:');
    expect(input).toContain('Code review history:');
    expect(input).toContain('Round 1: changes requested');
    expect(input).toContain('server/a.ts L4-9: guard null');
  });

  it('collapses a multi-line finding onto one line', () => {
    const input = buildRunSummaryInput({
      commits: [],
      reviewRounds: [
        {
          round: 1,
          verdict: 'changes_requested',
          findings: [{ filePath: 'a.ts', lineStart: null, lineEnd: null, body: 'one\n\ntwo' }],
          truncatedFindings: 0,
        },
      ],
    });

    expect(input).toContain('a.ts file-level: one two');
  });

  it('drops commits with an empty subject', () => {
    const input = buildRunSummaryInput({
      commits: [{ subject: '  ' }, { subject: 'real commit' }],
    });
    expect(input).toContain('- real commit');
    expect(input.match(/^- /gm)).toHaveLength(1);
  });
});

describe('parseRunSummaryResponse', () => {
  it('parses a plain JSON object', () => {
    expect(
      parseRunSummaryResponse(
        '{"summary":"Adds a widget.","reviewNotes":"One nit.","manualTesting":["Click it"]}',
      ),
    ).toEqual({
      summary: 'Adds a widget.',
      reviewNotes: 'One nit.',
      manualTesting: ['Click it'],
      followUps: [],
    });
  });

  it('parses follow-ups as their own bucket, separate from manual testing', () => {
    const parsed = parseRunSummaryResponse(
      '{"summary":"S","manualTesting":["Click it"],"followUps":["Run `npm run migrate` on prod"]}',
    );
    expect(parsed?.manualTesting).toEqual(['Click it']);
    expect(parsed?.followUps).toEqual(['Run `npm run migrate` on prod']);
  });

  it('applies the same marker-stripping and dedupe rules to follow-ups', () => {
    const parsed = parseRunSummaryResponse(
      '{"summary":"S","followUps":["- [ ] Run migrate","1. Set TOKEN","RUN MIGRATE","",7]}',
    );
    expect(parsed?.followUps).toEqual(['Run migrate', 'Set TOKEN']);
  });

  it('caps follow-ups at their own tighter limit', () => {
    const steps = Array.from({ length: MAX_FOLLOW_UP_STEPS + 5 }, (_, i) => `step ${i}`);
    const parsed = parseRunSummaryResponse(JSON.stringify({ summary: 'S', followUps: steps }));
    expect(parsed?.followUps).toHaveLength(MAX_FOLLOW_UP_STEPS);
    expect(MAX_FOLLOW_UP_STEPS).toBeLessThan(MAX_MANUAL_TESTING_STEPS);
  });

  // A response whose only content is a follow-up step is still a usable answer;
  // treating it as "no answer" would silently drop the migration nobody ran.
  it('keeps a response that carries follow-ups and nothing else', () => {
    const parsed = parseRunSummaryResponse(
      '{"summary":"","reviewNotes":"","manualTesting":[],"followUps":["Run migrate"]}',
    );
    expect(parsed?.followUps).toEqual(['Run migrate']);
  });

  it('recovers the object from a code fence with stray prose', () => {
    const parsed = parseRunSummaryResponse(
      'Sure!\n```json\n{"summary":"S","reviewNotes":"","manualTesting":["A"]}\n```\nHope that helps.',
    );
    expect(parsed?.summary).toBe('S');
    expect(parsed?.manualTesting).toEqual(['A']);
  });

  it('strips markdown list and checkbox markers off checklist entries', () => {
    const parsed = parseRunSummaryResponse(
      '{"summary":"S","manualTesting":["- [ ] Open the page","* Toggle it","1. Save it"]}',
    );
    expect(parsed?.manualTesting).toEqual(['Open the page', 'Toggle it', 'Save it']);
  });

  it('drops duplicate and empty checklist entries', () => {
    const parsed = parseRunSummaryResponse(
      '{"summary":"S","manualTesting":["Open it","open IT","   ",42,"Close it"]}',
    );
    expect(parsed?.manualTesting).toEqual(['Open it', 'Close it']);
  });

  it('caps the checklist length', () => {
    const steps = Array.from({ length: MAX_MANUAL_TESTING_STEPS + 5 }, (_, i) => `step ${i}`);
    const parsed = parseRunSummaryResponse(JSON.stringify({ summary: 'S', manualTesting: steps }));
    expect(parsed?.manualTesting).toHaveLength(MAX_MANUAL_TESTING_STEPS);
  });

  it('returns null for malformed or fully empty payloads', () => {
    expect(parseRunSummaryResponse('')).toBeNull();
    expect(parseRunSummaryResponse('no json here')).toBeNull();
    expect(parseRunSummaryResponse('{oops')).toBeNull();
    expect(parseRunSummaryResponse('[1,2,3]')).toBeNull();
    expect(
      parseRunSummaryResponse('{"summary":"","reviewNotes":"","manualTesting":[]}'),
    ).toBeNull();
  });

  it('accepts a payload carrying only a checklist', () => {
    const parsed = parseRunSummaryResponse('{"manualTesting":["Verify the migration ran"]}');
    expect(parsed).toEqual({
      summary: '',
      reviewNotes: '',
      manualTesting: ['Verify the migration ran'],
      followUps: [],
    });
  });
});

describe('generateFinalizeRunSummary', () => {
  it('returns null with no API key configured, without calling fetch', async () => {
    const fetchImpl = vi.fn();
    const result = await generateFinalizeRunSummary({
      commits: [{ subject: 'c' }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('calls OpenAI when the host OpenAI key is present', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(openaiResponse('{"summary":"S","manualTesting":["A"]}'));

    const result = await generateFinalizeRunSummary({
      commits: [{ subject: 'c' }],
      openaiApiKey: 'sk-openai-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(result?.summary).toBe('S');
  });

  it('never calls a non-OpenAI provider endpoint', async () => {
    // Policy pin: `AppConfig` has no host-wide Anthropic key — Claude
    // credentials are strictly per-account (server/config.ts, "AI provider
    // credentials"). Billing a user's personal Claude account for an automatic
    // background summary is out of scope, so OpenAI is the only wired provider.
    // If someone re-adds an Anthropic branch without a host key to feed it,
    // this fails.
    const fetchImpl = vi.fn().mockResolvedValue(openaiResponse('{"summary":"S"}'));

    await generateFinalizeRunSummary({
      commits: [{ subject: 'c' }],
      openaiApiKey: 'sk-openai-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    for (const call of fetchImpl.mock.calls) {
      expect(String(call[0])).not.toContain('anthropic.com');
    }
  });

  it('returns null on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    const result = await generateFinalizeRunSummary({
      commits: [{ subject: 'c' }],
      openaiApiKey: 'sk-openai-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  it('never throws when fetch rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(
      generateFinalizeRunSummary({
        commits: [{ subject: 'c' }],
        openaiApiKey: 'sk-openai-test',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBeNull();
  });

  it('returns null when there is nothing to summarize', async () => {
    const fetchImpl = vi.fn();
    const result = await generateFinalizeRunSummary({
      commits: [],
      openaiApiKey: 'sk-openai-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
