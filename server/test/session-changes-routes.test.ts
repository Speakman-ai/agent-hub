import { describe, it, expect, beforeAll } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createSession } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

describe('GET /api/sessions/:id/changes', () => {
  it('returns 404 for an unknown session', async () => {
    await request.get('/api/sessions/does-not-exist/changes').expect(404);
  });

  it('returns an empty change set for a session with no worktree', async () => {
    const session = await createSession();
    const res = await request.get(`/api/sessions/${session.id}/changes`).expect(200);
    expect(res.body).toMatchObject({
      baseSha: null,
      headSha: null,
      dirty: false,
      files: [],
      truncated: false,
    });
    expect(Array.isArray(res.body.files)).toBe(true);
  });
});

describe('GET /api/sessions/:id/changes/diff', () => {
  it('returns 404 for an unknown session', async () => {
    await request.get('/api/sessions/nope/changes/diff?file=x.ts').expect(404);
  });

  it('requires a file query parameter', async () => {
    const session = await createSession();
    await request.get(`/api/sessions/${session.id}/changes/diff`).expect(400);
  });

  it('returns 404 when the session has no worktree', async () => {
    const session = await createSession();
    await request.get(`/api/sessions/${session.id}/changes/diff?file=x.ts`).expect(404);
  });
});
