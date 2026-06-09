/**
 * Integration test for `GET /api/sessions/:sessionId/preview/state`.
 *
 * Drives the real Express app via supertest. The default test caller
 * resolves to Owner with auth disabled, so `userOwnsSession` is
 * permissive here — the ownership-404 cliff is exercised by the
 * dedicated auth/roles suites, not this file. We focus on route wiring:
 * the endpoint is mounted, owner callers get 200, and the response is
 * the `{ event }` envelope (null when no compose preview is active for
 * the session, which is the case for a freshly created session that
 * never started one).
 *
 * Regression intent: previously there was NO way for the client to
 * re-request preview state, so a dropped `ready` WS frame stranded the
 * pane on "Booting preview…". This endpoint is the hydration path; the
 * test guards its shape so the client reconcile keeps working.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createSession } from '../test/helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('GET /api/sessions/:sessionId/preview/state', () => {
  it('returns `{ event: null }` for a session with no active preview', async () => {
    const session = await createSession();
    const sessionId = session.id as string;
    const res = await request.get(`/api/sessions/${sessionId}/preview/state`).expect(200);
    expect(res.body).toEqual({ event: null });
  });

  it('returns the `{ event }` envelope (null) for an unknown session id under the no-auth bypass', async () => {
    // Auth is disabled in the test harness, so ownership is permissive
    // and the handler falls through to the runtime lookup, which has no
    // group for this id → null. (Ownership-gated 404 is covered by the
    // auth/roles suites.)
    const res = await request.get('/api/sessions/does-not-exist-0000/preview/state').expect(200);
    expect(res.body).toHaveProperty('event', null);
  });
});
