import { describe, it, expect } from 'vitest';
import { parseWikiRagIndicator } from './wikiRagIndicator';

const consulted = {
  wikiRag: {
    status: 'consulted',
    retrieved: 2,
    query: 'how does x work',
    pages: [
      { title: 'A', slug: 'a', category: 'architecture', score: 0.9, rawScore: 0.81 },
      { title: 'B', slug: 'b', category: 'general', score: 0.5 },
    ],
  },
};

describe('parseWikiRagIndicator', () => {
  it('parses a consulted indicator from a JSON string', () => {
    const ind = parseWikiRagIndicator(JSON.stringify(consulted));
    expect(ind).not.toBeNull();
    expect(ind!.status).toBe('consulted');
    expect(ind!.retrieved).toBe(2);
    expect(ind!.pages).toHaveLength(2);
    expect(ind!.pages[0]).toEqual({
      title: 'A',
      slug: 'a',
      category: 'architecture',
      score: 0.9,
      rawScore: 0.81,
    });
    // Missing rawScore is simply absent, not coerced to 0.
    expect(ind!.pages[1]).not.toHaveProperty('rawScore');
  });

  it('parses an already-parsed object (not just a string)', () => {
    const ind = parseWikiRagIndicator(consulted);
    expect(ind?.status).toBe('consulted');
  });

  it('parses a no_match indicator', () => {
    const ind = parseWikiRagIndicator(
      JSON.stringify({ wikiRag: { status: 'no_match', retrieved: 0, pages: [], query: 'q' } }),
    );
    expect(ind).toMatchObject({ status: 'no_match', retrieved: 0, pages: [] });
  });

  it('returns null for null / empty / non-wiki metadata', () => {
    expect(parseWikiRagIndicator(null)).toBeNull();
    expect(parseWikiRagIndicator('')).toBeNull();
    expect(parseWikiRagIndicator('   ')).toBeNull();
    expect(parseWikiRagIndicator(JSON.stringify({ other: true }))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseWikiRagIndicator('{not json')).toBeNull();
  });

  it('returns null when status is missing or invalid', () => {
    expect(parseWikiRagIndicator(JSON.stringify({ wikiRag: { retrieved: 1 } }))).toBeNull();
    expect(
      parseWikiRagIndicator(JSON.stringify({ wikiRag: { status: 'bogus', pages: [] } })),
    ).toBeNull();
  });

  it('drops malformed page rows but keeps valid ones', () => {
    const ind = parseWikiRagIndicator(
      JSON.stringify({
        wikiRag: {
          status: 'consulted',
          pages: [{ title: 'ok', slug: 'ok' }, { title: 'no-slug' }, null, 42],
        },
      }),
    );
    expect(ind!.pages).toHaveLength(1);
    expect(ind!.pages[0].slug).toBe('ok');
    // retrieved falls back to the parsed page count when not a finite number.
    expect(ind!.retrieved).toBe(1);
  });
});
