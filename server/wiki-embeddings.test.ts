import { describe, it, expect } from 'vitest';
import {
  chunkMarkdown,
  cosineSimilarity,
  normalizeScores,
  rankHybrid,
  encodeEmbedding,
  decodeEmbedding,
  type FtsHit,
  type SemanticHit,
} from './wiki-embeddings.js';
import type { WikiPageRow } from './types.js';

function mkPage(id: string, title = 'T', slug = 's'): WikiPageRow {
  return {
    id,
    project_id: 'proj',
    title,
    slug,
    content: '',
    category: 'general',
    updated_by: 'u',
    created_at: 'now',
    updated_at: 'now',
  };
}

describe('chunkMarkdown', () => {
  it('returns no chunks for empty input', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('   \n\n  ')).toEqual([]);
  });

  it('returns a single chunk for short content', () => {
    const chunks = chunkMarkdown('# Hello\n\nShort body.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.idx).toBe(0);
    expect(chunks[0]!.text).toContain('Hello');
  });

  it('splits on paragraph boundaries when exceeding maxChars', () => {
    // Build 5 paragraphs of 400 chars each; maxChars=1000 should produce ~3 chunks.
    const para = (n: number) => `P${n} ` + 'x'.repeat(396);
    const doc = [0, 1, 2, 3, 4].map(para).join('\n\n');
    const chunks = chunkMarkdown(doc, 1000, 100);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.length).toBeLessThanOrEqual(5);
    // Each chunk should contain at least one paragraph marker.
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(1200); // maxChars + overlap slack
    }
  });

  it('hard-slices a single paragraph larger than maxChars', () => {
    const mega = 'y'.repeat(5000);
    const chunks = chunkMarkdown(mega, 1000, 100);
    expect(chunks.length).toBeGreaterThan(1);
    // Total coverage should cover the full input (with overlap → more than 5000).
    const total = chunks.reduce((acc, c) => acc + c.text.length, 0);
    expect(total).toBeGreaterThanOrEqual(5000);
  });

  it('includes overlap between chunks for continuity', () => {
    const para = 'Z'.repeat(500);
    const doc = Array.from({ length: 6 }, () => para).join('\n\n');
    const chunks = chunkMarkdown(doc, 1000, 200);
    // We can't assert exact positions, but sibling chunks should share some tail/head text.
    if (chunks.length >= 2) {
      const tail = chunks[0]!.text.slice(-50);
      const head = chunks[1]!.text.slice(0, 250);
      expect(head).toContain(tail.slice(0, 10));
    }
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 5);
  });

  it('handles zero vectors without NaN', () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });

  it('handles mismatched lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});

describe('encodeEmbedding / decodeEmbedding', () => {
  it('round-trips through BLOB', () => {
    const values = [0.1, -0.2, 0.3, 1.5, -1.5];
    const buf = encodeEmbedding(values);
    const out = decodeEmbedding(buf);
    expect(out.length).toBe(values.length);
    for (let i = 0; i < values.length; i++) {
      expect(out[i]).toBeCloseTo(values[i]!, 5);
    }
  });
});

describe('normalizeScores', () => {
  it('maps to [0, 1]', () => {
    expect(normalizeScores([1, 2, 3, 4, 5])).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('returns all 1s when scores are equal (avoids div-by-zero)', () => {
    expect(normalizeScores([3, 3, 3])).toEqual([1, 1, 1]);
  });

  it('handles empty input', () => {
    expect(normalizeScores([])).toEqual([]);
  });
});

describe('rankHybrid', () => {
  const pageA = mkPage('a', 'Alpha', 'alpha');
  const pageB = mkPage('b', 'Beta', 'beta');
  const pageC = mkPage('c', 'Gamma', 'gamma');
  const lookup = new Map([
    ['a', pageA],
    ['b', pageB],
    ['c', pageC],
  ]);

  it('blends FTS and semantic scores 50/50 by default', () => {
    // pageA is top FTS, pageC is top semantic — a page that wins both should beat either.
    // Give pageB a strong position in both streams.
    const fts: FtsHit[] = [
      { pageId: 'a', page: pageA, bm25Rank: -5 },
      { pageId: 'b', page: pageB, bm25Rank: -4 },
      { pageId: 'c', page: pageC, bm25Rank: -1 },
    ];
    const semantic: SemanticHit[] = [
      { pageId: 'c', chunkIdx: 0, chunkText: 'c-chunk', score: 0.9 },
      { pageId: 'b', chunkIdx: 0, chunkText: 'b-chunk', score: 0.8 },
      { pageId: 'a', chunkIdx: 0, chunkText: 'a-chunk', score: 0.2 },
    ];

    const ranked = rankHybrid(fts, semantic, lookup);
    expect(ranked[0]!.page.id).toBe('b');
    const ids = ranked.map((r) => r.page.id);
    expect(ids).toContain('a');
    expect(ids).toContain('c');
  });

  it('honors custom weights — 100% FTS ignores semantic scores', () => {
    const fts: FtsHit[] = [
      { pageId: 'a', page: pageA, bm25Rank: -5 },
      { pageId: 'b', page: pageB, bm25Rank: -1 },
    ];
    const semantic: SemanticHit[] = [
      { pageId: 'b', chunkIdx: 0, chunkText: 'b', score: 0.99 },
      { pageId: 'a', chunkIdx: 0, chunkText: 'a', score: 0.1 },
    ];
    const ranked = rankHybrid(fts, semantic, lookup, { ftsWeight: 1, semanticWeight: 0 });
    expect(ranked[0]!.page.id).toBe('a'); // FTS says a is better
  });

  it('handles pages present in only one stream', () => {
    const fts: FtsHit[] = [{ pageId: 'a', page: pageA, bm25Rank: -3 }];
    const semantic: SemanticHit[] = [{ pageId: 'b', chunkIdx: 0, chunkText: 'b', score: 0.7 }];
    const ranked = rankHybrid(fts, semantic, lookup);
    const ids = ranked.map((r) => r.page.id);
    expect(ids).toEqual(expect.arrayContaining(['a', 'b']));
    // Each should have a 0 on the missing side.
    const a = ranked.find((r) => r.page.id === 'a')!;
    const b = ranked.find((r) => r.page.id === 'b')!;
    expect(a.semanticScore).toBe(0);
    expect(b.ftsScore).toBe(0);
  });

  it('respects the limit', () => {
    const fts: FtsHit[] = Array.from({ length: 10 }, (_, i) => ({
      pageId: String(i),
      page: mkPage(String(i)),
      bm25Rank: -i,
    }));
    const semantic: SemanticHit[] = [];
    const lookup2 = new Map(fts.map((h) => [h.pageId, h.page]));
    const ranked = rankHybrid(fts, semantic, lookup2, { limit: 3 });
    expect(ranked).toHaveLength(3);
  });

  it('keeps best-scoring chunk per page for semanticScore', () => {
    const fts: FtsHit[] = [];
    const semantic: SemanticHit[] = [
      { pageId: 'a', chunkIdx: 0, chunkText: 'low', score: 0.1 },
      { pageId: 'a', chunkIdx: 1, chunkText: 'high', score: 0.9 },
    ];
    const ranked = rankHybrid(fts, semantic, lookup);
    expect(ranked[0]!.matchedChunk).toBe('high');
  });
});
