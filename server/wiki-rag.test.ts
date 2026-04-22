import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildWikiRagContext,
  buildWikiRagContextFromQuery,
  detectWikiRequestBlock,
  effectiveWikiHybridRagUsedCount,
  formatWikiRagContext,
  MAX_AGENTHUB_CONTROL_BLOCK_JSON_BYTES,
  MAX_WIKI_RAG_CALLS_PER_SESSION,
  normalizeRagQuery,
  nextWikiHybridRagRowAfterIncrement,
  parseWikiRequestBlock,
  shouldAttachWikiRag,
  runWikiHybridRagForAssistantRequest,
  runWikiHybridRagForUserTurn,
} from './wiki-rag.js';
import { searchWiki } from './wiki-embeddings.js';

vi.mock('./wiki-embeddings.js', () => ({
  searchWiki: vi.fn(),
}));

const mockedSearchWiki = vi.mocked(searchWiki);

describe('effectiveWikiHybridRagUsedCount', () => {
  it('treats legacy budget_version 0 with consumed ≥ 1 as exhausted', () => {
    expect(effectiveWikiHybridRagUsedCount(1, 0, MAX_WIKI_RAG_CALLS_PER_SESSION)).toBe(
      MAX_WIKI_RAG_CALLS_PER_SESSION,
    );
    expect(effectiveWikiHybridRagUsedCount(0, 0, MAX_WIKI_RAG_CALLS_PER_SESSION)).toBe(0);
  });

  it('uses raw counter when budget_version is 1', () => {
    expect(effectiveWikiHybridRagUsedCount(3, 1, MAX_WIKI_RAG_CALLS_PER_SESSION)).toBe(3);
    expect(effectiveWikiHybridRagUsedCount(99, 1, MAX_WIKI_RAG_CALLS_PER_SESSION)).toBe(
      MAX_WIKI_RAG_CALLS_PER_SESSION,
    );
  });
});

describe('nextWikiHybridRagRowAfterIncrement', () => {
  it('moves legacy never-used row to counter mode', () => {
    expect(nextWikiHybridRagRowAfterIncrement(0, 0, MAX_WIKI_RAG_CALLS_PER_SESSION)).toEqual({
      consumed: 1,
      budgetVersion: 1,
    });
  });

  it('increments monotonic counter', () => {
    expect(nextWikiHybridRagRowAfterIncrement(4, 1, MAX_WIKI_RAG_CALLS_PER_SESSION)).toEqual({
      consumed: 5,
      budgetVersion: 1,
    });
  });
});

describe('normalizeRagQuery', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeRagQuery('  schema   migrations \n\n sqlite ')).toBe(
      'schema migrations sqlite',
    );
  });
});

describe('shouldAttachWikiRag', () => {
  it('allows first-turn retrieval when the query is long enough and no slash skill', () => {
    expect(
      shouldAttachWikiRag({
        wikiHybridRagUsedCount: 0,
        userMessage: 'how does kanban integration work in this project?',
        slashSkillActive: false,
      }),
    ).toBe(true);
  });

  it('skips when this session already used its hybrid RAG budget cap', () => {
    expect(
      shouldAttachWikiRag({
        wikiHybridRagUsedCount: 10,
        userMessage: 'how does kanban integration work in this project?',
        slashSkillActive: false,
      }),
    ).toBe(false);
  });

  it('skips when legacy gate row maps to exhausted via effective count', () => {
    const used = effectiveWikiHybridRagUsedCount(1, 0, MAX_WIKI_RAG_CALLS_PER_SESSION);
    expect(used).toBe(MAX_WIKI_RAG_CALLS_PER_SESSION);
    expect(
      shouldAttachWikiRag({
        wikiHybridRagUsedCount: used,
        userMessage: 'how does kanban integration work in this project?',
        slashSkillActive: false,
      }),
    ).toBe(false);
  });

  it('skips short first messages (no embedding signal)', () => {
    expect(
      shouldAttachWikiRag({
        wikiHybridRagUsedCount: 0,
        userMessage: 'hi',
        slashSkillActive: false,
      }),
    ).toBe(false);
  });

  it('skips slash-skill turns', () => {
    expect(
      shouldAttachWikiRag({
        wikiHybridRagUsedCount: 0,
        userMessage: '/some-skill explain the wiki search api in detail please',
        slashSkillActive: true,
      }),
    ).toBe(false);
  });
});

describe('assistant wiki request block parsing', () => {
  it('detects the last <agenthub:wiki> block', () => {
    const text = [
      '<agenthub:wiki>{"query":"first"}</agenthub:wiki>',
      '<agenthub:wiki>{"query":"second"}</agenthub:wiki>',
    ].join('\n');
    const out = detectWikiRequestBlock(text);
    expect(out).toContain('second');
    expect(out).not.toContain('first"}</agenthub:wiki>');
  });

  it('parses valid payload and rejects malformed payloads', () => {
    expect(
      parseWikiRequestBlock('<agenthub:wiki>{"query":"schema updates"}</agenthub:wiki>'),
    ).toEqual({ query: 'schema updates' });
    expect(parseWikiRequestBlock('<agenthub:wiki>{bad}</agenthub:wiki>')).toMatchObject({
      error: 'malformed',
    });
    expect(parseWikiRequestBlock('<agenthub:wiki>{"foo":"bar"}</agenthub:wiki>')).toMatchObject({
      error: 'malformed',
    });
  });

  it('rejects wiki JSON over the byte cap before parse', () => {
    const q = 'x'.repeat(MAX_AGENTHUB_CONTROL_BLOCK_JSON_BYTES + 100);
    const raw = `<agenthub:wiki>${JSON.stringify({ query: q })}</agenthub:wiki>`;
    const out = parseWikiRequestBlock(raw);
    expect(out).toMatchObject({ error: 'malformed' });
    if ('error' in out) expect(out.detail).toMatch(/byte cap/);
  });
});

describe('formatWikiRagContext', () => {
  it('returns empty string for empty rows', () => {
    expect(formatWikiRagContext('query', [])).toBe('');
  });

  it('formats ranked rows into a compact prompt block', () => {
    const out = formatWikiRagContext('schema changes', [
      {
        id: '1',
        project_id: 'p',
        title: 'Database Schema',
        slug: 'database-schema',
        category: 'architecture',
        updated_by: 'agent',
        created_at: 'now',
        updated_at: 'now',
        score: 0.82,
        snippet: 'Use <mark>migrations</mark> for schema updates',
      },
    ]);
    expect(out).toContain('## Retrieved Wiki Context');
    expect(out).toContain('Query: "schema changes"');
    expect(out).toContain('Database Schema (architecture)');
    expect(out).toContain('migrations');
    expect(out).not.toContain('<mark>');
  });
});

describe('buildWikiRagContext', () => {
  beforeEach(() => {
    mockedSearchWiki.mockReset();
  });

  it('skips retrieval for blank query', async () => {
    const out = await buildWikiRagContext('project-1', '   ');
    expect(out).toBe('');
    expect(mockedSearchWiki).not.toHaveBeenCalled();
  });

  it('calls hybrid wiki search and returns a formatted block', async () => {
    mockedSearchWiki.mockResolvedValueOnce([
      {
        id: '1',
        project_id: 'p',
        title: 'Kanban Flow',
        slug: 'kanban-flow',
        category: 'conventions',
        updated_by: 'agent',
        created_at: 'now',
        updated_at: 'now',
        score: 0.91,
        matchedChunk: 'Cards move through Backlog, In Progress, Review, Done.',
      },
    ]);

    const out = await buildWikiRagContext('project-1', 'how do cards move on our board?');
    expect(mockedSearchWiki).toHaveBeenCalledWith('project-1', 'how do cards move on our board?', {
      mode: 'hybrid',
      limit: 6,
    });
    expect(out).toContain('Kanban Flow');
    expect(out).toContain('Backlog');
  });

  it('supports direct query retrieval for assistant-authored queries', async () => {
    mockedSearchWiki.mockResolvedValueOnce([
      {
        id: '1',
        project_id: 'p',
        title: 'Prompt Budget',
        slug: 'prompt-budget',
        category: 'conventions',
        updated_by: 'agent',
        created_at: 'now',
        updated_at: 'now',
        score: 0.77,
        matchedChunk: 'Use budgets and caps to avoid context blowups.',
      },
    ]);
    const out = await buildWikiRagContextFromQuery('project-1', 'how do prompt budgets work');
    expect(out).toContain('Prompt Budget');
  });
});

describe('runWikiHybridRagForUserTurn (chat orchestration)', () => {
  beforeEach(() => {
    mockedSearchWiki.mockReset();
  });

  it('skips when wiki_hybrid_rag was already consumed for the session', async () => {
    const r = await runWikiHybridRagForUserTurn(
      'p1',
      'how does the wiki search api work please explain',
      {
        wikiHybridRagUsedCount: 10,
        slashSkillActive: false,
      },
    );
    expect(r.promptSuffix).toBe('');
    expect(r.shouldIncrementWikiHybridRagUsage).toBe(false);
    expect(r.logWarning).toBe(null);
    expect(mockedSearchWiki).not.toHaveBeenCalled();
  });

  it('runs hybrid retrieval on a later long turn when budget remains (e.g. forwarded session)', async () => {
    mockedSearchWiki.mockResolvedValueOnce([
      {
        id: '1',
        project_id: 'p1',
        title: 'X',
        slug: 'x',
        category: 'c',
        updated_by: 'a',
        created_at: 'n',
        updated_at: 'n',
        score: 1,
        matchedChunk: 'hit',
      },
    ]);
    const r = await runWikiHybridRagForUserTurn(
      'p1',
      'this is a long enough question about our wiki?',
      {
        wikiHybridRagUsedCount: 0,
        slashSkillActive: false,
      },
    );
    expect(r.shouldIncrementWikiHybridRagUsage).toBe(true);
    expect(r.logWarning).toBe(null);
    expect(r.promptSuffix).toContain('X');
  });

  it('marks consumed after a successful call even when the formatted block is empty', async () => {
    mockedSearchWiki.mockResolvedValueOnce([]);
    const r = await runWikiHybridRagForUserTurn(
      'p1',
      'enough characters here to qualify for hybrid rag run',
      {
        wikiHybridRagUsedCount: 0,
        slashSkillActive: false,
      },
    );
    expect(r.promptSuffix).toBe('');
    expect(r.shouldIncrementWikiHybridRagUsage).toBe(true);
  });

  it('does not mark consumed when buildWikiRagContext throws (allows retry on a later turn)', async () => {
    mockedSearchWiki.mockRejectedValueOnce(new Error('embedding unavailable'));
    const r = await runWikiHybridRagForUserTurn(
      'p1',
      'enough characters here to qualify for hybrid rag run',
      {
        wikiHybridRagUsedCount: 0,
        slashSkillActive: false,
      },
    );
    expect(r.shouldIncrementWikiHybridRagUsage).toBe(false);
    expect(r.logWarning).toBe('embedding unavailable');
  });
});

describe('runWikiHybridRagForAssistantRequest', () => {
  beforeEach(() => {
    mockedSearchWiki.mockReset();
  });

  it('returns a malformed error suffix for invalid JSON', async () => {
    const r = await runWikiHybridRagForAssistantRequest(
      'p1',
      '<agenthub:wiki>{bad}</agenthub:wiki>',
      { wikiHybridRagUsedCount: 0 },
    );
    expect(r.promptSuffix).toBe('');
    expect(r.errorSuffix).toContain('Malformed <agenthub:wiki>');
    expect(r.shouldIncrementWikiHybridRagUsage).toBe(false);
  });

  it('enforces session retrieval budget cap', async () => {
    const r = await runWikiHybridRagForAssistantRequest(
      'p1',
      '<agenthub:wiki>{"query":"how does routing work?"}</agenthub:wiki>',
      { wikiHybridRagUsedCount: 3, maxCallsPerSession: 3 },
    );
    expect(r.promptSuffix).toBe('');
    expect(r.errorSuffix).toContain('budget exhausted');
    expect(r.shouldIncrementWikiHybridRagUsage).toBe(false);
    expect(mockedSearchWiki).not.toHaveBeenCalled();
  });

  it('returns context and increments usage on success', async () => {
    mockedSearchWiki.mockResolvedValueOnce([
      {
        id: '1',
        project_id: 'p1',
        title: 'Agent Routing',
        slug: 'agent-routing',
        category: 'architecture',
        updated_by: 'a',
        created_at: 'n',
        updated_at: 'n',
        score: 0.9,
        matchedChunk: 'Routing happens in server/chat.ts.',
      },
    ]);
    const r = await runWikiHybridRagForAssistantRequest(
      'p1',
      '<agenthub:wiki>{"query":"how does routing happen?"}</agenthub:wiki>',
      { wikiHybridRagUsedCount: 0, maxCallsPerSession: 3 },
    );
    expect(r.promptSuffix).toContain('Retrieved Wiki Context');
    expect(r.shouldIncrementWikiHybridRagUsage).toBe(true);
    expect(r.errorSuffix).toBe('');
  });
});
