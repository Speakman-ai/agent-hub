import { describe, it, expect } from 'vitest';
import {
  formatCodeRagContext,
  normalizeCodeRagQuery,
  shouldAttachCodeRag,
  runCodeRagForUserTurn,
  MAX_CODE_RAG_CALLS_PER_SESSION,
} from './code-rag.js';
import type { CodeSearchResult } from './code-embeddings.js';

function mkRow(over: Partial<CodeSearchResult> = {}): CodeSearchResult {
  return {
    filePath: 'server/foo.ts',
    chunkIdx: 0,
    startLine: 10,
    endLine: 24,
    text: 'export function foo() {\n  return 42;\n}',
    score: 0.87,
    ...over,
  };
}

describe('normalizeCodeRagQuery', () => {
  it('collapses whitespace and clips long input', () => {
    expect(normalizeCodeRagQuery('  hello   world \n')).toBe('hello world');
    expect(normalizeCodeRagQuery('x'.repeat(1000)).length).toBeLessThanOrEqual(600);
  });
});

describe('formatCodeRagContext', () => {
  it('returns empty string for no rows', () => {
    expect(formatCodeRagContext('q', [])).toBe('');
  });

  it('renders citations as path:start-end and fences the code', () => {
    const out = formatCodeRagContext('how does foo work', [mkRow()]);
    expect(out).toContain('## Retrieved Project Code');
    expect(out).toContain('server/foo.ts:10-24');
    expect(out).toContain('```');
    expect(out).toContain('export function foo()');
  });

  it('caps to the max number of results', () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      mkRow({ filePath: `f${i}.ts`, startLine: i }),
    );
    const out = formatCodeRagContext('q', rows);
    const cited = (out.match(/\.ts:/g) || []).length;
    expect(cited).toBeLessThanOrEqual(6);
  });
});

describe('shouldAttachCodeRag', () => {
  const base = {
    codeRagUsedCount: 0,
    userMessage: 'how does the parser handle tokens in this project',
    slashSkillActive: false,
    projectId: 'nonexistent-project-xyz',
  };

  it('returns false for short queries', () => {
    expect(shouldAttachCodeRag({ ...base, userMessage: 'hi' })).toBe(false);
  });

  it('returns false when the session budget is exhausted', () => {
    expect(shouldAttachCodeRag({ ...base, codeRagUsedCount: MAX_CODE_RAG_CALLS_PER_SESSION })).toBe(
      false,
    );
  });

  it('returns false on slash-skill turns', () => {
    expect(shouldAttachCodeRag({ ...base, slashSkillActive: true })).toBe(false);
  });

  it('returns false when the project has no indexed code', () => {
    // Unknown project → countProjectCodeChunks() == 0 → no embedding call.
    expect(shouldAttachCodeRag(base)).toBe(false);
  });
});

describe('runCodeRagForUserTurn', () => {
  it('skips (no suffix, no increment) when ineligible', async () => {
    const r = await runCodeRagForUserTurn('nonexistent-project-xyz', 'short', {
      codeRagUsedCount: 0,
      slashSkillActive: false,
    });
    expect(r.promptSuffix).toBe('');
    expect(r.shouldIncrementCodeRagUsage).toBe(false);
    expect(r.logWarning).toBeNull();
  });

  it('skips when project has no indexed code even with a long query', async () => {
    const r = await runCodeRagForUserTurn(
      'nonexistent-project-xyz',
      'explain the websocket streaming flow in detail please',
      { codeRagUsedCount: 0, slashSkillActive: false },
    );
    expect(r.promptSuffix).toBe('');
    expect(r.shouldIncrementCodeRagUsage).toBe(false);
  });
});
