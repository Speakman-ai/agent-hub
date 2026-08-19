import type supertest from 'supertest';
import { getRequest, createProject, createWikiPage } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// Zod schema validation for wiki routes
//
// Confirms each wiki endpoint that the migration touched returns a
// 400 with an `error` message + `details` array on bad input. The
// pre-Zod handlers hand-rolled `if (!field) return 400` for the only
// truly required field (`title` on create); the migration moved that
// wiring to `.safeParse(req.body)` with schemas defined in
// `server/routes/wiki.openapi.ts`.
//
// These tests pin:
//   - the status code (400 — surface-stable)
//   - the presence of `details` (the new Zod-issue array)
//   - back-compat 400 reasons that pre-existing callers expected
//     (`Title is required` from the legacy hand-rolled check)
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = (await createProject()) as { id: string };
  projectId = project.id;
});

describe('Schema validation — POST /wiki', () => {
  it('rejects empty body with 400', async () => {
    const res = await request.post(`/api/projects/${projectId}/wiki`).send({}).expect(400);
    expect((res.body as { error: string }).error).toMatch(/title is required/i);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });

  it('rejects empty-string title (400) — Zod min(1) treats it like missing', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/wiki`)
      .send({ title: '', content: 'whatever' })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/title is required/i);
  });

  it('rejects non-string title (400)', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/wiki`)
      .send({ title: 42 })
      .expect(400);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });

  it('accepts a minimal payload (title only) and creates the page (201)', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/wiki`)
      .send({ title: `Schema OK Page ${Date.now()}` })
      .expect(201);
    expect((res.body as { slug: string }).slug).toBeTruthy();
  });
});

describe('Schema validation — PUT /wiki/:slug', () => {
  it('treats omitted keys as "preserve" (no-op update succeeds)', async () => {
    const page = (await createWikiPage(projectId, {
      title: `put-noop-${Date.now()}`,
      content: 'original',
    })) as { slug: string };
    const res = await request
      .put(`/api/projects/${projectId}/wiki/${page.slug}`)
      .send({})
      .expect(200);
    // Update returns the page with the (unchanged) content.
    expect((res.body as { content: string }).content).toBe('original');
  });

  it('rejects empty-string title (400) — Zod min(1) treats it like an invalid rename', async () => {
    const page = (await createWikiPage(projectId, {
      title: `put-empty-title-${Date.now()}`,
    })) as { slug: string };
    await request
      .put(`/api/projects/${projectId}/wiki/${page.slug}`)
      .send({ title: '' })
      .expect(400);
  });

  it('rejects non-string content (400)', async () => {
    const page = (await createWikiPage(projectId, {
      title: `put-bad-content-${Date.now()}`,
    })) as { slug: string };
    await request
      .put(`/api/projects/${projectId}/wiki/${page.slug}`)
      .send({ content: 123 })
      .expect(400);
  });

  it('returns 404 for unknown slug', async () => {
    await request
      .put(`/api/projects/${projectId}/wiki/does-not-exist-${Date.now()}`)
      .send({ content: 'whatever' })
      .expect(404);
  });
});

describe('Schema validation — GET /wiki (query params)', () => {
  it('rejects non-numeric limit (400)', async () => {
    const res = await request
      .get(`/api/projects/${projectId}/wiki?q=anything&limit=banana`)
      .expect(400);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });

  it('coerces a numeric limit and returns FTS hits', async () => {
    await createWikiPage(projectId, {
      title: `fts-limit-${Date.now()}`,
      content: 'searchable bananas content',
    });
    const res = await request.get(`/api/projects/${projectId}/wiki?q=bananas&limit=5`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('accepts an empty query string (falls through to listPages)', async () => {
    const res = await request.get(`/api/projects/${projectId}/wiki`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('Schema validation — GET /wiki/search (query params)', () => {
  it('rejects unknown mode (400)', async () => {
    const res = await request
      .get(`/api/projects/${projectId}/wiki/search?q=x&mode=quantum`)
      .expect(400);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });

  it('rejects non-numeric limit (400)', async () => {
    const res = await request
      .get(`/api/projects/${projectId}/wiki/search?q=x&limit=abc`)
      .expect(400);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });

  it('returns empty envelope for a blank query without hitting Gemini', async () => {
    const res = await request.get(`/api/projects/${projectId}/wiki/search?q=`).expect(200);
    const body = res.body as {
      results: unknown[];
      geminiConfigured: boolean;
      mode: string;
    };
    expect(body.results).toEqual([]);
    expect(typeof body.geminiConfigured).toBe('boolean');
    expect(body.mode).toBe('hybrid');
  });
});

describe('Schema validation — POST /wiki/document-backfill', () => {
  it('rejects a non-integer limit (400)', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/wiki/document-backfill`)
      .send({ limit: 1.5 })
      .expect(400);
    expect(Array.isArray((res.body as { details: unknown[] }).details)).toBe(true);
  });

  it('rejects a limit above the cap (400)', async () => {
    await request
      .post(`/api/projects/${projectId}/wiki/document-backfill`)
      .send({ limit: 100 })
      .expect(400);
  });

  it('returns 404 when the project has no docs agent', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/wiki/document-backfill`)
      .send({ limit: 5 })
      .expect(404);
    expect((res.body as { error: string }).error).toMatch(/docs agent/i);
  });
});

describe('Schema validation — DELETE /wiki/:slug', () => {
  it('returns 404 for unknown slug', async () => {
    await request
      .delete(`/api/projects/${projectId}/wiki/does-not-exist-${Date.now()}`)
      .expect(404);
  });

  it('deletes an existing page (200) and is idempotent on second call (404)', async () => {
    const page = (await createWikiPage(projectId, {
      title: `delete-me-${Date.now()}`,
    })) as { slug: string };
    await request.delete(`/api/projects/${projectId}/wiki/${page.slug}`).expect(200);
    await request.delete(`/api/projects/${projectId}/wiki/${page.slug}`).expect(404);
  });
});
