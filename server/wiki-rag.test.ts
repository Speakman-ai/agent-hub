import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildWikiRagContext,
  formatWikiRagContext,
  normalizeRagQuery,
  shouldAttachWikiRag,
  runWikiHybridRagForUserTurn,
} from './wiki-rag.js';
import { searchWiki } from './wiki-embeddings.js';

vi.mock('./wiki-embeddings.js', () => ({
  searchWiki: vi.fn(),
}));

const mockedSearchWiki = vi.mocked(searchWiki);

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
        hybridRagNotYetConsumed: true,
        userMessage: 'how does kanban integration work in this project?',
        slashSkillActive: false,
      }),
    ).toBe(true);
  });

  it('skips when this session already used its hybrid RAG budget', () => {
    expect(
      shouldAttachWikiRag({
        hybridRagNotYetConsumed: false,
        userMessage: 'how does kanban integration work in this project?',
        slashSkillActive: false,
      }),
    ).toBe(false);
  });

  it('skips short first messages (no embedding signal)', () => {
    expect(
      shouldAttachWikiRag({
        hybridRagNotYetConsumed: true,
        userMessage: 'hi',
        slashSkillActive: false,
      }),
    ).toBe(false);
  });

  it('skips slash-skill turns', () => {
    expect(
      shouldAttachWikiRag({
        hybridRagNotYetConsumed: true,
        userMessage: '/some-skill explain the wiki search api in detail please',
        slashSkillActive: true,
      }),
    ).toBe(false);
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
      limit: 4,
    });
    expect(out).toContain('Kanban Flow');
    expect(out).toContain('Backlog');
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
        wikiHybridRagConsumed: 1,
        slashSkillActive: false,
      },
    );
    expect(r.promptSuffix).toBe('');
    expect(r.shouldMarkWikiHybridRagConsumed).toBe(false);
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
        wikiHybridRagConsumed: 0,
        slashSkillActive: false,
      },
    );
    expect(r.shouldMarkWikiHybridRagConsumed).toBe(true);
    expect(r.logWarning).toBe(null);
    expect(r.promptSuffix).toContain('X');
  });

  it('marks consumed after a successful call even when the formatted block is empty', async () => {
    mockedSearchWiki.mockResolvedValueOnce([]);
    const r = await runWikiHybridRagForUserTurn(
      'p1',
      'enough characters here to qualify for hybrid rag run',
      {
        wikiHybridRagConsumed: 0,
        slashSkillActive: false,
      },
    );
    expect(r.promptSuffix).toBe('');
    expect(r.shouldMarkWikiHybridRagConsumed).toBe(true);
  });

  it('does not mark consumed when buildWikiRagContext throws (allows retry on a later turn)', async () => {
    mockedSearchWiki.mockRejectedValueOnce(new Error('embedding unavailable'));
    const r = await runWikiHybridRagForUserTurn(
      'p1',
      'enough characters here to qualify for hybrid rag run',
      {
        wikiHybridRagConsumed: 0,
        slashSkillActive: false,
      },
    );
    expect(r.shouldMarkWikiHybridRagConsumed).toBe(false);
    expect(r.logWarning).toBe('embedding unavailable');
  });
});
