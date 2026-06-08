/**
 * Integration tests for the code-RAG routes. Drives the real Express app via
 * supertest.
 *
 * IMPORTANT: these tests never send a *valid* code-index body. A valid body
 * would call `indexProjectCode`, which — when a real `GEMINI_API_KEY` is present
 * in the environment (as it can be locally / in CI secrets) — performs a live
 * embedding network call. Tests must not hit the network. Instead we assert that
 * out-of-bounds bodies are rejected with 400 *before* any indexing work, which
 * is the security-relevant guarantee (a bad `maxFiles` must never reach the
 * indexer and trigger a partial scan / accidental prune). The indexer happy
 * path is covered by `code-embeddings.test.ts` with a mock embedder.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { beforeAll, describe, it, expect } from 'vitest';
import { getRequest, createProject } from '../test/helpers.js';

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject({ cwd: '/tmp' });
  projectId = project.id as string;
});

describe('POST /api/projects/:projectId/code-index — body validation', () => {
  it('404s for an unknown project', async () => {
    await request.post('/api/projects/does-not-exist-xyz/code-index').send({}).expect(404);
  });

  it('rejects negative maxFiles with 400 (does not reach the indexer)', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/code-index`)
      .send({ maxFiles: -1 })
      .expect(400);
    expect(res.body.error).toBeTruthy();
  });

  it('rejects zero maxFiles with 400', async () => {
    await request.post(`/api/projects/${projectId}/code-index`).send({ maxFiles: 0 }).expect(400);
  });

  it('rejects non-integer maxFiles with 400', async () => {
    await request.post(`/api/projects/${projectId}/code-index`).send({ maxFiles: 1.5 }).expect(400);
  });

  it('rejects an over-large maxFiles with 400', async () => {
    await request
      .post(`/api/projects/${projectId}/code-index`)
      .send({ maxFiles: 999999 })
      .expect(400);
  });
});

describe('GET /api/projects/:projectId/code-index/status', () => {
  it('reports zero chunks and gemini state for an un-indexed project', async () => {
    const res = await request.get(`/api/projects/${projectId}/code-index/status`).expect(200);
    expect(res.body.chunks).toBe(0);
    expect(typeof res.body.geminiConfigured).toBe('boolean');
  });

  it('404s for an unknown project', async () => {
    await request.get('/api/projects/does-not-exist-xyz/code-index/status').expect(404);
  });
});

describe('GET /api/projects/:projectId/code-search', () => {
  it('returns an empty envelope for a blank query', async () => {
    const res = await request.get(`/api/projects/${projectId}/code-search`).expect(200);
    expect(res.body.results).toEqual([]);
  });

  it('rejects an unknown mode with 400', async () => {
    await request
      .get(`/api/projects/${projectId}/code-search`)
      .query({ q: 'parser', mode: 'bogus' })
      .expect(400);
  });

  it('404s for an unknown project', async () => {
    await request.get('/api/projects/does-not-exist-xyz/code-search').expect(404);
  });
});
