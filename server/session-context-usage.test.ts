import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildContextUsageReport,
  classifyPromptSections,
  contextTokensFromClaudeUsage,
  contextWindowForModel,
  estimateTokens,
  getContextUsageSnapshot,
  recordContextTurn,
  recordReportedContext,
  recordReportedContextWindow,
  contextWindowFromClaudeModelUsage,
} from './session-context-usage.js';
import { createStreamParser } from './stream-parser.js';

function memDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(
    "CREATE TABLE session_context_usage (session_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  return db;
}

const PROMPT = [
  '# You are Dev',
  '',
  'Agent id: `dev`',
  '',
  '## AGENTS.md',
  '# AGENTS.md - proj',
  '## Session Startup',
  'Read SOUL.md',
  '',
  '## CLAUDE.md',
  '## Web Search — Required for Opinions, Best Practices & Recommendations',
  'quoted hub heading inside CLAUDE.md',
  '',
  '## Identity Reminder',
  'You are Dev.',
  '',
  '## Available Skills',
  '- **kanban**: board ops',
  '',
  '## ReAct Loop',
  'tools',
  '',
  '## Project Wiki (3 pages; 3 most-recent shown)',
  '- page',
  '',
  '## Kanban Board — Task Self-Reporting',
  'cards',
  '',
  "## Today's Notes (2026-10-12)",
  '## 16:59',
  'note',
  '',
  '## Git Workflow',
  'branch rules',
  '',
  '## Loaded Skill: kanban',
  '```bash',
  '## not a heading',
  '```',
  '## Git Workflow',
  'skill body that reuses a hub heading',
].join('\n');

function sliceChars(start: string, end: string | null): number {
  const a = PROMPT.indexOf(start);
  const b = end ? PROMPT.indexOf(end, a + 1) : PROMPT.length;
  return b - a;
}

describe('classifyPromptSections', () => {
  it('splits a Hub prompt by section and keeps file sub-headings with their file', () => {
    const out = classifyPromptSections(PROMPT);
    expect(Object.values(out).reduce((a, b) => a + b, 0)).toBe(PROMPT.length);
    // AGENTS.md through Identity Reminder, including the Hub heading CLAUDE.md quotes.
    expect(out.rules).toBe(sliceChars('## AGENTS.md', '## Available Skills'));
    expect(out.skills).toBe(
      sliceChars('## Available Skills', '## ReAct Loop') + sliceChars('## Loaded Skill', null),
    );
    expect(out.wiki).toBe(sliceChars('## Project Wiki', '## Kanban Board'));
    expect(out.memory).toBe(sliceChars("## Today's Notes", '## Git Workflow'));
  });

  it('counts everything as system when there are no category headings', () => {
    expect(classifyPromptSections('# You are X\n\nbody')).toEqual({
      system: 17,
      rules: 0,
      skills: 0,
      wiki: 0,
      memory: 0,
    });
  });
});

describe('contextWindowForModel', () => {
  it('maps engines and the [1m] opt-in', () => {
    expect(contextWindowForModel('claude-code', 'opus')).toBe(200_000);
    expect(contextWindowForModel('claude-code', 'claude-opus-4-6[1m]')).toBe(1_000_000);
    expect(contextWindowForModel('gemini-cli', 'gemini-2.5-pro')).toBe(1_048_576);
    expect(contextWindowForModel('codex-cli', 'gpt-5-codex')).toBe(272_000);
    expect(contextWindowForModel('cursor-agent', 'sonnet-4.5')).toBe(200_000);
    expect(contextWindowForModel('cursor-agent', 'auto')).toBeNull();
  });
});

describe('contextTokensFromClaudeUsage', () => {
  it('sums input, cache, and output tokens', () => {
    expect(
      contextTokensFromClaudeUsage({
        input_tokens: 10,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 3000,
        output_tokens: 40,
      }),
    ).toBe(3250);
    expect(contextTokensFromClaudeUsage({})).toBeNull();
    expect(contextTokensFromClaudeUsage(undefined)).toBeNull();
  });

  it('is emitted by the Claude stream parser and tagged for subagent frames', () => {
    const parser = createStreamParser('claude-code');
    const usage = { input_tokens: 5, cache_read_input_tokens: 995, output_tokens: 0 };
    const lines = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }], usage } },
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_1',
        message: { content: [], usage: { input_tokens: 7 } },
      },
    ];
    const events = parser.feed(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const usageEvents = events.filter((e) => e.type === 'context_usage');
    expect(usageEvents).toEqual([
      { type: 'context_usage', contextTokens: 1000 },
      { type: 'context_usage', contextTokens: 7, parentToolUseId: 'toolu_1' },
    ]);
  });
});

describe('snapshot + report', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = memDb();
  });

  const systemPrompt = '# You are Dev\n\n## AGENTS.md\n' + 'a'.repeat(3986) + '\n## ReAct Loop\nx';

  it('derives the engine share from the first step of a fresh CLI session', () => {
    const snap = recordContextTurn(db, 's1', {
      engine: 'claude-code',
      model: 'opus',
      systemPrompt,
      userTurn: 'u'.repeat(400),
      freshEngineSession: true,
    });
    const hub = Object.values(snap.promptTokens).reduce((a, b) => a + b, 0);
    expect(snap.awaitingBaseline).toBe(true);

    expect(recordReportedContext(db, 's1', hub + 100 + 15_000)).toBe(true);
    const after = getContextUsageSnapshot(db, 's1')!;
    expect(after.engineTokens).toBe(15_000);

    // Later steps grow the conversation; the engine share stays fixed.
    recordReportedContext(db, 's1', hub + 15_000 + 40_000);
    const report = buildContextUsageReport({
      sessionId: 's1',
      engine: 'claude-code',
      model: 'opus',
      snapshot: getContextUsageSnapshot(db, 's1'),
      transcriptChars: 0,
    });
    expect(report.source).toBe('reported');
    expect(report.totalTokens).toBe(hub + 55_000);
    expect(report.contextWindow).toBe(200_000);
    expect(report.categories.find((c) => c.key === 'engine')?.tokens).toBe(15_000);
    expect(report.categories.find((c) => c.key === 'conversation')?.tokens).toBe(40_000);
    expect(report.categories.find((c) => c.key === 'rules')?.tokens).toBeGreaterThan(900);
    expect(report.percent).toBeCloseTo(((hub + 55_000) / 200_000) * 100, 0);
  });

  it('keeps the engine share across resumed turns and resets it on a fresh session', () => {
    recordContextTurn(db, 's2', {
      engine: 'claude-code',
      model: 'opus',
      systemPrompt,
      userTurn: 'hi',
      freshEngineSession: true,
    });
    recordReportedContext(db, 's2', 20_000);
    const engineTokens = getContextUsageSnapshot(db, 's2')!.engineTokens;

    recordContextTurn(db, 's2', {
      engine: 'claude-code',
      model: 'opus',
      systemPrompt: '# You are Dev',
      userTurn: 'next',
      freshEngineSession: false,
    });
    const resumed = getContextUsageSnapshot(db, 's2')!;
    expect(resumed.engineTokens).toBe(engineTokens);
    expect(resumed.awaitingBaseline).toBe(false);

    recordContextTurn(db, 's2', {
      engine: 'claude-code',
      model: 'opus',
      systemPrompt: '# You are Dev',
      userTurn: 'restart',
      freshEngineSession: true,
    });
    const fresh = getContextUsageSnapshot(db, 's2')!;
    expect(fresh.engineTokens).toBeNull();
    expect(fresh.reportedTokens).toBeNull();
    expect(fresh.awaitingBaseline).toBe(true);
  });

  it('does not guess an engine share for a session resumed before tracking began', () => {
    recordContextTurn(db, 's3', {
      engine: 'claude-code',
      model: 'opus',
      systemPrompt,
      userTurn: 'hi',
      freshEngineSession: false,
    });
    recordReportedContext(db, 's3', 90_000);
    const report = buildContextUsageReport({
      sessionId: 's3',
      engine: 'claude-code',
      model: 'opus',
      snapshot: getContextUsageSnapshot(db, 's3'),
      transcriptChars: 0,
    });
    expect(report.categories.some((c) => c.key === 'engine')).toBe(false);
    expect(report.totalTokens).toBe(90_000);
  });

  it('estimates from the transcript when the engine reports nothing', () => {
    recordContextTurn(db, 's4', {
      engine: 'cursor-agent',
      model: 'auto',
      systemPrompt,
      userTurn: 'hi',
      freshEngineSession: true,
    });
    const report = buildContextUsageReport({
      sessionId: 's4',
      engine: 'cursor-agent',
      model: 'auto',
      snapshot: getContextUsageSnapshot(db, 's4'),
      transcriptChars: 8000,
    });
    expect(report.source).toBe('estimated');
    expect(report.categories.find((c) => c.key === 'conversation')?.tokens).toBe(2000);
    expect(report.contextWindow).toBeNull();
    expect(report.percent).toBeNull();
  });

  it('reports none for a session with no turns', () => {
    const report = buildContextUsageReport({
      sessionId: 'empty',
      engine: 'claude-code',
      model: 'opus',
      snapshot: null,
      transcriptChars: 0,
    });
    expect(report.source).toBe('none');
    expect(report.totalTokens).toBe(0);
    expect(report.categories).toEqual([]);
  });

  it('ignores reports before any turn was recorded', () => {
    expect(recordReportedContext(db, 'nope', 500)).toBe(false);
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('keeps the measured total when estimates overshoot it', () => {
    recordContextTurn(db, 's5', {
      engine: 'claude-code',
      model: 'opus',
      systemPrompt: '## AGENTS.md\n' + 'a'.repeat(48_000),
      userTurn: 'hi',
      freshEngineSession: false,
    });
    recordReportedContext(db, 's5', 10_000);
    const report = buildContextUsageReport({
      sessionId: 's5',
      engine: 'claude-code',
      model: 'opus',
      snapshot: getContextUsageSnapshot(db, 's5'),
      transcriptChars: 0,
    });
    expect(report.source).toBe('reported');
    expect(report.totalTokens).toBe(10_000);
    expect(report.categories.reduce((a, c) => a + c.tokens, 0)).toBe(10_000);
    expect(report.categories.find((c) => c.key === 'conversation')?.tokens).toBe(0);
    expect(report.percent).toBe(5);
  });

  it('uses the engine-reported window for a 1M session without the [1m] suffix', () => {
    recordContextTurn(db, 's6', {
      engine: 'claude-code',
      model: 'opus',
      systemPrompt: '# You are X',
      userTurn: 'hi',
      freshEngineSession: false,
    });
    recordReportedContext(db, 's6', 150_000);
    recordReportedContextWindow(db, 's6', 1_000_000);
    const report = buildContextUsageReport({
      sessionId: 's6',
      engine: 'claude-code',
      model: 'opus',
      snapshot: getContextUsageSnapshot(db, 's6'),
      transcriptChars: 0,
    });
    expect(report.contextWindow).toBe(1_000_000);
    expect(report.percent).toBe(15);
  });

  it('widens a guessed window that a measured total already exceeds', () => {
    recordContextTurn(db, 's7', {
      engine: 'claude-code',
      model: 'opus',
      systemPrompt: '# You are X',
      userTurn: 'hi',
      freshEngineSession: false,
    });
    recordReportedContext(db, 's7', 300_000);
    const report = buildContextUsageReport({
      sessionId: 's7',
      engine: 'claude-code',
      model: 'opus',
      snapshot: getContextUsageSnapshot(db, 's7'),
      transcriptChars: 0,
    });
    expect(report.contextWindow).toBe(1_000_000);
    expect(report.percent).toBe(30);
  });

  it('forgets the reported window when the model changes', () => {
    const turn = (model: string) =>
      recordContextTurn(db, 's8', {
        engine: 'claude-code',
        model,
        systemPrompt: '# You are X',
        userTurn: 'hi',
        freshEngineSession: false,
      });
    turn('opus');
    recordReportedContextWindow(db, 's8', 1_000_000);
    turn('opus');
    expect(getContextUsageSnapshot(db, 's8')!.contextWindow).toBe(1_000_000);
    turn('haiku');
    expect(getContextUsageSnapshot(db, 's8')!.contextWindow).toBeNull();
  });
});

describe('contextWindowFromClaudeModelUsage', () => {
  const modelUsage = {
    'claude-sonnet-4-5-20250929': { contextWindow: 200_000 },
    'claude-opus-4-6': { contextWindow: 1_000_000 },
  };

  it("picks the parent model's entry, not the largest", () => {
    expect(contextWindowFromClaudeModelUsage(modelUsage, 'claude-sonnet-4-5-20250929')).toBe(
      200_000,
    );
    expect(contextWindowFromClaudeModelUsage(modelUsage, 'claude-sonnet-4-5')).toBe(200_000);
    expect(contextWindowFromClaudeModelUsage(modelUsage, 'claude-opus-4-6[1m]')).toBe(1_000_000);
  });

  it('returns null when the parent model is unknown or unmatched and entries are ambiguous', () => {
    expect(contextWindowFromClaudeModelUsage(modelUsage, null)).toBeNull();
    expect(contextWindowFromClaudeModelUsage(modelUsage, 'claude-haiku-4-5')).toBeNull();
    expect(
      contextWindowFromClaudeModelUsage({ 'claude-opus-4-6': { contextWindow: 1_000_000 } }, null),
    ).toBe(1_000_000);
    expect(contextWindowFromClaudeModelUsage({}, null)).toBeNull();
  });

  it("uses the parent's window when a subagent on a larger-window model ran", () => {
    const lines = [
      { type: 'system', subtype: 'init', session_id: 'x', model: 'claude-sonnet-4-5-20250929' },
      {
        type: 'assistant',
        message: { model: 'claude-sonnet-4-5-20250929', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_1',
        message: { model: 'claude-opus-4-6', content: [{ type: 'text', text: 'sub' }] },
      },
      { type: 'result', result: 'done', modelUsage },
    ];
    const events = createStreamParser('claude-code').feed(
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
    expect(events.filter((e) => e.type === 'context_usage')).toEqual([
      { type: 'context_usage', contextWindow: 200_000 },
    ]);
  });

  it('emits no window when the parent model never appeared and entries are ambiguous', () => {
    const events = createStreamParser('claude-code').feed(
      JSON.stringify({ type: 'result', result: 'done', modelUsage }) + '\n',
    );
    expect(events.filter((e) => e.type === 'context_usage')).toEqual([]);
  });
});
