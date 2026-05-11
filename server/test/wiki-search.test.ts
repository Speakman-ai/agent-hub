import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject, createWikiPage } from './helpers.js';
import { setEmbedClient, type EmbedClient, type EmbeddingVector } from '../wiki-embeddings.js';

/**
 * Deterministic bag-of-words mock for the Gemini embed client. Each unique
 * token gets an axis; vectors are L1-normalized so dot products roughly
 * behave like cosine similarity. That's enough for the route tests to
 * verify ordering without hitting the network.
 */
function bagOfWordsClient(): EmbedClient {
  const vocab = new Map<string, number>();
  function idx(token: string): number {
    if (!vocab.has(token)) vocab.set(token, vocab.size);
    return vocab.get(token)!;
  }
  function vectorize(text: string): number[] {
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const v: number[] = [];
    for (const t of tokens) {
      const i = idx(t);
      while (v.length <= i) v.push(0);
      v[i]! += 1;
    }
    // Pad to a stable length so embed order doesn't matter.
    const size = Math.max(v.length, vocab.size);
    while (v.length < size) v.push(0);
    return v;
  }
  return {
    async embedTexts(texts: string[]): Promise<EmbeddingVector[]> {
      // First embed pass — lock in the vocab, then rebuild to a common length.
      const raw = texts.map(vectorize);
      const size = vocab.size;
      return raw.map((v) => {
        while (v.length < size) v.push(0);
        return { values: v };
      });
    },
  };
}

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  // Force the env var so `isGeminiConfigured()` returns true. The injected
  // client never actually uses the key.
  process.env.GEMINI_API_KEY = 'test-key';
  setEmbedClient(bagOfWordsClient());

  request = await getRequest();
  const proj = (await createProject()) as { id: string };
  projectId = proj.id;

  // Seed a few semantically distinct pages.
  await createWikiPage(projectId, {
    title: 'Database Migrations and Schema',
    content: `
# Database Migrations

We use better-sqlite3 with raw SQL. Every schema change goes through a migration
in server/db.ts. WAL mode is enabled for concurrent reads.

## Table creation

Use \`CREATE TABLE IF NOT EXISTS\` for idempotency.
`,
    category: 'architecture',
  });
  await createWikiPage(projectId, {
    title: 'Kanban Card Workflow',
    content: `
# Kanban Board

Cards move through To Do -> In Progress -> Review -> Done.
Session IDs link cards to active Agent Hub sessions.
`,
    category: 'architecture',
  });
  await createWikiPage(projectId, {
    title: 'Unrelated Page about Cooking',
    content: `Recipes and pasta, nothing to do with code.`,
    category: 'general',
  });

  // Wait a tick so the scheduleEmbedPage setImmediate callbacks have flushed.
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(() => {
  setEmbedClient(null);
});

describe('GET /api/projects/:projectId/wiki/search', () => {
  it('returns an empty result set for an empty query', async () => {
    const res = await request.get(`/api/projects/${projectId}/wiki/search?q=`).expect(200);
    expect(res.body.results).toEqual([]);
  });

  it('runs in fts mode by request', async () => {
    const res = await request
      .get(`/api/projects/${projectId}/wiki/search?q=migration&mode=fts`)
      .expect(200);
    expect(res.body.mode).toBe('fts');
    expect(Array.isArray(res.body.results)).toBe(true);
    // FTS should find the migrations page.
    const titles = res.body.results.map((r: { title: string }) => r.title);
    expect(titles[0]).toMatch(/Migration/i);
  });

  it('runs in semantic mode and returns chunk metadata', async () => {
    const res = await request
      .get(`/api/projects/${projectId}/wiki/search?q=schema%20change%20SQL&mode=semantic`)
      .expect(200);
    expect(res.body.mode).toBe('semantic');
    expect(res.body.results.length).toBeGreaterThan(0);
    const top = res.body.results[0];
    expect(top).toHaveProperty('semanticScore');
    expect(top).toHaveProperty('matchedChunk');
  });

  it('runs in hybrid mode by default and returns both score components', async () => {
    const res = await request
      .get(`/api/projects/${projectId}/wiki/search?q=migrations`)
      .expect(200);
    expect(res.body.mode).toBe('hybrid');
    expect(res.body.results.length).toBeGreaterThan(0);
    const top = res.body.results[0];
    expect(top).toHaveProperty('ftsScore');
    expect(top).toHaveProperty('semanticScore');
    expect(top).toHaveProperty('score');
  });

  it('ranks more-relevant pages above less-relevant ones in hybrid', async () => {
    const res = await request
      .get(`/api/projects/${projectId}/wiki/search?q=migrations%20sqlite`)
      .expect(200);
    const ids = res.body.results.map((r: { title: string }) => r.title);
    const migrationIdx = ids.findIndex((t: string) => /Migration/i.test(t));
    const cookingIdx = ids.findIndex((t: string) => /Cooking/i.test(t));
    // Cooking page should either be absent or below the migrations page.
    if (migrationIdx !== -1 && cookingIdx !== -1) {
      expect(migrationIdx).toBeLessThan(cookingIdx);
    } else {
      expect(migrationIdx).toBeGreaterThanOrEqual(0);
    }
  });

  it('rejects unknown projects with 404', async () => {
    await request.get('/api/projects/does-not-exist/wiki/search?q=anything').expect(404);
  });
});

describe('POST /api/projects/:projectId/wiki/reembed', () => {
  it('reembeds all pages idempotently', async () => {
    const res = await request.post(`/api/projects/${projectId}/wiki/reembed`).expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(3);
    expect(res.body.embedded).toBeGreaterThanOrEqual(3);
    expect(res.body.errors).toEqual([]);
  });

  it('returns 503 when Gemini is not configured', async () => {
    const prevEnv = process.env.GEMINI_API_KEY;
    const cfg = (await import('../config.js')).default as {
      geminiApiKey: string | null;
    };
    const prevCfg = cfg.geminiApiKey;
    delete process.env.GEMINI_API_KEY;
    cfg.geminiApiKey = null;
    try {
      const res = await request.post(`/api/projects/${projectId}/wiki/reembed`).expect(503);
      expect(res.body.error).toMatch(/Gemini/i);
    } finally {
      if (prevEnv) process.env.GEMINI_API_KEY = prevEnv;
      cfg.geminiApiKey = prevCfg;
    }
  });
});

describe('Backward compatibility', () => {
  it('legacy ?q= on /wiki still returns FTS results', async () => {
    const res = await request.get(`/api/projects/${projectId}/wiki?q=migration`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
