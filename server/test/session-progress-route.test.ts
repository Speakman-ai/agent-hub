/**
 * Integration test for GET /api/sessions/:sessionId/progress — the endpoint
 * the in-Hub ProgressPanel calls on session mount to rehydrate its steps.
 */
import './setup.js';
import type supertest from 'supertest';
import { getRequest, createSession } from './helpers.js';
import { getStmts } from '../db.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('GET /api/sessions/:sessionId/progress', () => {
  it('returns an empty steps array for a session with no progress rows', async () => {
    const session = (await createSession()) as { id: string };
    const res = await request.get(`/api/sessions/${session.id}/progress`).expect(200);
    expect(res.body).toEqual({ sessionId: session.id, steps: [] });
  });

  it('returns persisted steps in emit order with camelCase timing fields', async () => {
    const session = (await createSession()) as { id: string };
    const stmts = getStmts();
    stmts.addSessionProgress.run(session.id, 'msg-1', 'Gather PR context', 'completed', 1000, 1500);
    stmts.addSessionProgress.run(
      session.id,
      'msg-1',
      'Analyze diff and files',
      'started',
      2000,
      null,
    );

    const res = await request.get(`/api/sessions/${session.id}/progress`).expect(200);
    expect(res.body.sessionId).toBe(session.id);
    expect(res.body.steps).toHaveLength(2);
    expect(res.body.steps[0]).toMatchObject({
      step: 'Gather PR context',
      status: 'completed',
      startedAt: 1000,
      finishedAt: 1500,
    });
    expect(res.body.steps[1]).toMatchObject({
      step: 'Analyze diff and files',
      status: 'started',
      startedAt: 2000,
    });
    // `finishedAt` is omitted (or null) for started steps.
    expect(res.body.steps[1].finishedAt ?? null).toBeNull();
  });

  it('retains progress rows when the session is archived (soft-deleted) so restore preserves the panel', async () => {
    // DELETE is now a soft-delete — progress rows are intentionally preserved
    // so `POST /api/sessions/:id/restore` can bring the ProgressPanel back to
    // its prior state. The 7-day purge (bulk DELETE) is what actually reclaims
    // these rows.
    const session = (await createSession()) as { id: string };
    const stmts = getStmts();
    stmts.addSessionProgress.run(session.id, null, 'X', 'started', 1, null);

    // Sanity: rows exist
    expect((stmts.getSessionProgress.all(session.id) as unknown[]).length).toBe(1);

    await request.delete(`/api/sessions/${session.id}`).expect(200);
    expect((stmts.getSessionProgress.all(session.id) as unknown[]).length).toBe(1);

    // After restore, rows are still there.
    await request.post(`/api/sessions/${session.id}/restore`).expect(200);
    expect((stmts.getSessionProgress.all(session.id) as unknown[]).length).toBe(1);
  });
});
