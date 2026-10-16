import { describe, expect, it } from 'vitest';
import {
  buildRoutineDraftPrompt,
  extractRoutineDraft,
  formatDemoStep,
  formatDemoSteps,
  parseDemoRecording,
  suggestRoutineSkillName,
} from './routine-draft.js';
import type { DemoRecording } from './browser-demo-recorder.js';

function recording(overrides: Partial<DemoRecording> = {}): DemoRecording {
  return {
    schemaVersion: 1,
    kind: 'agent-hub.browser-demo',
    sessionId: 's1',
    startedAt: '2026-10-16T10:00:00.000Z',
    endedAt: '2026-10-16T10:02:00.000Z',
    durationMs: 120_000,
    stopReason: 'stopped',
    startUrl: 'https://example.com/login',
    truncated: false,
    steps: [
      { t: 0, type: 'navigate', url: 'https://example.com/reports', source: 'url_bar' },
      {
        t: 2_000,
        type: 'click',
        url: 'https://example.com/reports',
        x: 10,
        y: 20,
        button: 'left',
        clickCount: 1,
        selector: '#export',
        text: 'Export CSV',
        tag: 'button',
      },
      {
        t: 3_000,
        type: 'type',
        url: 'https://example.com/reports',
        text: '••••••••',
        masked: true,
        selector: 'input[type=password]',
        tag: 'input',
      } as unknown as DemoRecording['steps'][number],
      {
        t: 4_000,
        type: 'type',
        url: 'https://example.com/reports',
        text: 'Q3 totals',
        masked: false,
        selector: '#search',
        tag: 'input',
      } as unknown as DemoRecording['steps'][number],
      { t: 5_000, type: 'key', url: null, key: 'Enter', modifiers: ['Control'] },
      { t: 6_000, type: 'scroll', url: null, deltaX: 0, deltaY: 300 },
    ],
    ...overrides,
  };
}

describe('parseDemoRecording', () => {
  it('accepts a recording from a buffer or a string', () => {
    const rec = recording();
    expect(parseDemoRecording(Buffer.from(JSON.stringify(rec)))?.steps).toHaveLength(6);
    expect(parseDemoRecording(JSON.stringify(rec))?.kind).toBe('agent-hub.browser-demo');
  });

  it.each([
    ['a null step', [null]],
    ['a step without a time', [{ type: 'navigate', url: 'https://x' }]],
    ['an unknown step type', [{ t: 0, type: 'hover' }]],
    ['a navigate without a url', [{ t: 0, type: 'navigate', url: 5 }]],
    ['a click without coordinates', [{ t: 0, type: 'click', x: '1', y: 2 }]],
    ['typed text that is not a string', [{ t: 0, type: 'type', text: 42, masked: false }]],
    ['a type step with no mask flag', [{ t: 0, type: 'type', text: 'x' }]],
    ['a key that is not a string', [{ t: 0, type: 'key', key: { k: 1 } }]],
  ])('rejects a recording with %s', (_label, steps) => {
    expect(
      parseDemoRecording(JSON.stringify({ kind: 'agent-hub.browser-demo', steps })),
    ).toBeNull();
  });

  it('drops mistyped optional fields so formatting cannot throw', () => {
    const rec = parseDemoRecording(
      JSON.stringify({
        kind: 'agent-hub.browser-demo',
        durationMs: 'long',
        startUrl: 7,
        steps: [
          { t: 0, type: 'click', x: 1, y: 2, text: 99, selector: ['#a'], tag: {}, button: 'x' },
          { t: 1, type: 'type', text: 'hi', masked: false, selector: 3 },
          { t: 2, type: 'key', key: 'Enter', modifiers: ['Shift', 4] },
          { t: 3, type: 'scroll', deltaY: 'down' },
        ],
      }),
    );
    expect(rec).not.toBeNull();
    expect(rec!.steps[0]).toMatchObject({ text: null, selector: null, tag: null, button: 'left' });
    expect(rec!.durationMs).toBe(0);
    expect(rec!.startUrl).toBeNull();
    expect(() => buildRoutineDraftPrompt({ recording: rec!, projectName: 'P' })).not.toThrow();
    expect(formatDemoStep(rec!.steps[2]!)).toBe('[0s] Pressed Shift+Enter');
  });

  it('rejects other JSON and non-JSON', () => {
    expect(parseDemoRecording('{"kind":"other","steps":[]}')).toBeNull();
    expect(parseDemoRecording('{"kind":"agent-hub.browser-demo"}')).toBeNull();
    expect(parseDemoRecording('not json')).toBeNull();
  });
});

describe('formatDemoStep', () => {
  it('describes clicks by visible text, tag and selector', () => {
    expect(formatDemoStep(recording().steps[1]!)).toBe(
      '[2s] Clicked "Export CSV" <button> selector `#export`',
    );
  });

  it('never includes the value of masked input', () => {
    const line = formatDemoStep({
      t: 3_000,
      type: 'type',
      url: null,
      text: 'hunter2-should-not-appear',
      masked: true,
      selector: '#pw',
      tag: 'input',
    } as unknown as DemoRecording['steps'][number]);
    expect(line).not.toContain('hunter2');
    expect(line).toContain('secret value');
  });

  it('keeps typed text and key combos', () => {
    const steps = recording().steps;
    expect(formatDemoStep(steps[3]!)).toContain('"Q3 totals"');
    expect(formatDemoStep(steps[4]!)).toBe('[5s] Pressed Control+Enter');
    expect(formatDemoStep(steps[5]!)).toBe('[6s] Scrolled down');
  });
});

describe('formatDemoSteps', () => {
  it('cuts at a line boundary and says how many steps were dropped', () => {
    const out = formatDemoSteps(recording(), 80);
    expect(out.truncated).toBe(true);
    expect(out.text.split('\n').at(-1)).toMatch(/more steps omitted/);
  });
});

describe('buildRoutineDraftPrompt', () => {
  it('embeds the steps in a fence the data cannot close, plus the safety rules', () => {
    const rec = recording();
    (rec.steps[3] as { text: string }).text = 'has ``` inside';
    const prompt = buildRoutineDraftPrompt({
      recording: rec,
      projectName: 'Acme',
      agentName: 'Ops',
      goal: 'Export the weekly report',
    });
    expect(prompt).toContain('````text');
    expect(prompt).toContain('Export the weekly report');
    expect(prompt).toContain('request_login');
    expect(prompt).toContain('`approval` ReAct tool');
    expect(prompt).toContain('## Success checks');
    expect(prompt).not.toContain('••••••••');
  });
});

describe('extractRoutineDraft', () => {
  it('parses frontmatter and body, even inside a code fence with preamble', () => {
    const out = [
      '```markdown',
      'Here you go:',
      '---',
      'name: weekly-report-export',
      'description: Export the weekly report CSV.',
      'category: general',
      '---',
      '',
      '## Goal',
      'Export it.',
      '```',
    ].join('\n');
    expect(extractRoutineDraft(out, 'fallback')).toEqual({
      name: 'weekly-report-export',
      description: 'Export the weekly report CSV.',
      body: '## Goal\nExport it.\n',
    });
  });

  it('falls back to the suggested name when the model returns a bad slug', () => {
    const d = extractRoutineDraft('---\nname: Not A Slug\n---\n## Steps\n1. Go', 'recorded-x');
    expect(d?.name).toBe('recorded-x');
    expect(d?.description).toBe('');
  });

  it('keeps a body with no frontmatter and rejects an empty reply', () => {
    expect(extractRoutineDraft('## Steps\n1. Open', 'r')?.body).toBe('## Steps\n1. Open\n');
    expect(extractRoutineDraft('   ', 'r')).toBeNull();
  });
});

describe('suggestRoutineSkillName', () => {
  it('slugs free text and falls back when nothing is left', () => {
    expect(suggestRoutineSkillName('Export the Weekly Report!')).toBe('export-the-weekly-report');
    expect(suggestRoutineSkillName('browser-demo-20261016-100000.json')).toBe(
      'browser-demo-20261016-100000-json',
    );
    expect(suggestRoutineSkillName('***')).toBe('recorded-routine');
  });
});
