import type { ChildProcess } from 'child_process';
import type supertest from 'supertest';
import { getRequest, createSession, createProject, createAgent } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('POST /api/sessions/:sessionId/create-pr', () => {
  it('returns 404 for a non-existent session', async () => {
    const res = await request
      .post('/api/sessions/non-existent-id/create-pr')
      .send({ autoMerge: false });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 400 when session has no worktree', async () => {
    const session = await createSession();
    const res = await request
      .post(`/api/sessions/${session.id}/create-pr`)
      .send({ autoMerge: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no worktree/i);
  });

  it('returns 403 when the project is in workflow mode', async () => {
    const proj = await createProject();
    await request.patch(`/api/projects/${proj.id}`).send({ mode: 'workflow' }).expect(200);
    const agent = await createAgent({ projectId: String(proj.id) });
    const session = await createSession({ agentId: agent.id as string });
    const res = await request.post(`/api/sessions/${session.id}/create-pr`).send({});
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/workflow mode/i);
  });

  it('accepts autoMerge boolean and title string', async () => {
    // Session without worktree — will fail at 400, but validates the body parsing
    const session = await createSession();
    const res = await request
      .post(`/api/sessions/${session.id}/create-pr`)
      .send({ autoMerge: true, title: 'Fix the bug' });
    // Should fail with no-worktree before reaching git operations
    expect(res.status).toBe(400);
  });

  it('accepts autoMerge=true in the body without crashing', async () => {
    const session = await createSession();
    const res = await request
      .post(`/api/sessions/${session.id}/create-pr`)
      .send({ autoMerge: true });
    // Still short-circuits on the missing worktree, but the endpoint must
    // not reject requests that include an explicit opt-in.
    expect(res.status).toBe(400);
  });

  it('accepts explicit autoMerge=false (opt-out) in the body', async () => {
    const session = await createSession();
    const res = await request
      .post(`/api/sessions/${session.id}/create-pr`)
      .send({ autoMerge: false });
    expect(res.status).toBe(400);
  });

  it('accepts a body with no autoMerge field (falls through to project default)', async () => {
    const session = await createSession();
    const res = await request.post(`/api/sessions/${session.id}/create-pr`).send({});
    expect(res.status).toBe(400);
  });

  // ─── Server-side guards mirroring the client gates that were removed ──
  // The web client previously refused to render the Create-ticket-&-PR
  // button while the session was streaming or attached to a [Resolve PR #N]
  // session. With those client gates dropped (PR #1104), the server is now
  // the single source of truth for "you can't do that here."

  it('returns 409 when the session has an active engine process (streaming)', async () => {
    const session = await createSession();
    const sessionId = session.id as string;

    // Inject a fake ChildProcess-like entry into the activeProcesses Map.
    // The route only checks `.has(sessionId)` so a placeholder object is
    // enough — no real CLI is spawned (server/test/setup.ts blocks that).
    const { activeProcesses } = await import('../index.js');
    const fakeProc = { kill: () => {} } as unknown as ChildProcess;
    activeProcesses.set(sessionId, fakeProc);
    try {
      const res = await request
        .post(`/api/sessions/${sessionId}/create-pr`)
        .send({ autoMerge: false });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'session_streaming' });
      expect(String(res.body.error)).toMatch(/streaming/i);
    } finally {
      activeProcesses.delete(sessionId);
    }
  });

  it('returns 409 for a [Resolve PR #N] session (existing-PR fix flow, not a new PR)', async () => {
    const session = await createSession({ name: '[Resolve PR #42] Fix the thing' });
    const res = await request
      .post(`/api/sessions/${session.id}/create-pr`)
      .send({ autoMerge: false });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'resolve_pr_session' });
    expect(String(res.body.error)).toMatch(/Resolve PR session/i);
  });

  it('streaming guard fires before the no-worktree check (ordering matters)', async () => {
    // A streaming session with no worktree would otherwise short-circuit at
    // the 400 no-worktree branch. The 409 must fire first so the user gets
    // an actionable "wait for the agent" message instead of a misleading
    // "no worktree" error.
    const session = await createSession();
    const sessionId = session.id as string;
    const { activeProcesses } = await import('../index.js');
    const fakeProc = { kill: () => {} } as unknown as ChildProcess;
    activeProcesses.set(sessionId, fakeProc);
    try {
      const res = await request.post(`/api/sessions/${sessionId}/create-pr`).send({});
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('session_streaming');
    } finally {
      activeProcesses.delete(sessionId);
    }
  });

  it('resolve-PR guard fires before the no-worktree check (ordering matters)', async () => {
    const session = await createSession({ name: '[Resolve PR #99] Patch' });
    const res = await request.post(`/api/sessions/${session.id}/create-pr`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('resolve_pr_session');
  });
});
