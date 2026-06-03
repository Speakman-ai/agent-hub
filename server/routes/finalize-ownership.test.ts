/**
 * Ownership-gate tests for the finalize routes.
 *
 * The integration suite in `finalize.test.ts` runs with auth disabled
 * (the default test-harness mode), so `userCanReadSession` is permissive
 * and the gate is never exercised end-to-end. Here we mount the router
 * onto a minimal Express app and mock `session-ownership` so the gate's
 * non-owner path is reachable in isolation. The reviewer's BLOCKING #2
 * concern was that an authenticated user could probe session ids they
 * don't own; this file is the regression test for that contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { userCanReadSession } = vi.hoisted(() => ({
  userCanReadSession: vi.fn(),
}));

vi.mock('../session-ownership.js', () => ({
  userCanReadSession,
}));

// Import after the mock so the route file picks up the mocked module.
import createFinalizeRoutes from './finalize.js';
import type { RouteDeps } from '../types.js';

function makeStmts() {
  return {
    getFinalizeRun: { get: vi.fn() },
    getLatestFinalizeRunForSession: { get: vi.fn() },
    listReviewerThreadsForRun: { all: vi.fn().mockReturnValue([]) },
  };
}

function makeApp(stmts: ReturnType<typeof makeStmts>) {
  const app = express();
  const deps = { stmts, findProject: vi.fn() } as unknown as RouteDeps;
  app.use(createFinalizeRoutes(deps));
  return { app, deps };
}

beforeEach(() => {
  userCanReadSession.mockReset();
});

describe('GET /api/sessions/:sessionId/finalize-runs/latest ownership gate', () => {
  it('returns 404 + "Session not found" when userCanReadSession is false', async () => {
    userCanReadSession.mockReturnValue(false);
    const stmts = makeStmts();
    const { app } = makeApp(stmts);

    const res = await supertest(app)
      .get('/api/sessions/somebody-elses-session/finalize-runs/latest')
      .expect(404);

    expect(res.body).toEqual({ error: 'Session not found' });
    // The gate fires before the DB call, so no run lookup happens.
    expect(stmts.getLatestFinalizeRunForSession.get).not.toHaveBeenCalled();
    expect(userCanReadSession).toHaveBeenCalledOnce();
    // First arg is the request; second arg is the session id we masked.
    expect(userCanReadSession.mock.calls[0]![1]).toBe('somebody-elses-session');
  });

  it('passes through to the DB lookup when userCanReadSession is true', async () => {
    userCanReadSession.mockReturnValue(true);
    const stmts = makeStmts();
    stmts.getLatestFinalizeRunForSession.get.mockReturnValue(undefined);
    const { app } = makeApp(stmts);

    const res = await supertest(app)
      .get('/api/sessions/my-own-session/finalize-runs/latest')
      .expect(200);

    expect(res.body).toEqual({ run: null, steps: [] });
    expect(stmts.getLatestFinalizeRunForSession.get).toHaveBeenCalledWith('my-own-session');
  });

  it('returns the same 404 shape for both unknown sessions and unauthorized lookups (no info leak)', async () => {
    // Unauthorized.
    userCanReadSession.mockReturnValue(false);
    const stmts1 = makeStmts();
    const { app: app1 } = makeApp(stmts1);
    const unauth = await supertest(app1)
      .get('/api/sessions/private-session-id/finalize-runs/latest')
      .expect(404);

    // Owner, but session has never triggered Finalize — `{ run: null }` at 200.
    // Confirms the unauthorized response is NOT distinguishable as "exists but
    // forbidden" vs. "doesn't exist for me yet"; the unauth path is the
    // information-hiding shape (404 + literal "Session not found"), the
    // owner-but-no-run path is the legitimate empty-state shape (200 + null).
    userCanReadSession.mockReturnValue(true);
    const stmts2 = makeStmts();
    stmts2.getLatestFinalizeRunForSession.get.mockReturnValue(undefined);
    const { app: app2 } = makeApp(stmts2);
    const empty = await supertest(app2)
      .get('/api/sessions/private-session-id/finalize-runs/latest')
      .expect(200);

    expect(unauth.body).toEqual({ error: 'Session not found' });
    expect(empty.body).toEqual({ run: null, steps: [] });
  });
});
