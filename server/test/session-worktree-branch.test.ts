/**
 * Tests for `PUT /api/sessions/:sessionId/worktree-branch` — the session Branch
 * picker that positions a worktree on an existing remote branch.
 *
 * The endpoint is the general form of the resolve-PR head-branch mechanism, so
 * the guards matter: it must reject unsafe branch names, refuse to mutate a
 * session whose worktree is already provisioned (the One-Session-One-Branch
 * invariant Finalize keys off), and refuse sessions that don't use a worktree.
 */
import type supertest from 'supertest';
import { getRequest, createProject, createAgent, createSession } from './helpers.js';
import { getDb } from '../db.js';

let request: supertest.Agent;

interface SessionBody {
  id: string;
  worktree_checkout_branch?: string | null;
}

async function freshWorktreeSession(): Promise<string> {
  const project = await createProject();
  const agent = await createAgent({ projectId: project.id as string });
  const session = (await createSession({
    agentId: agent.id as string,
  })) as unknown as SessionBody;
  return session.id;
}

beforeAll(async () => {
  request = await getRequest();
});

describe('PUT /api/sessions/:sessionId/worktree-branch', () => {
  it('records a chosen existing branch on a not-yet-provisioned worktree session', async () => {
    const sessionId = await freshWorktreeSession();

    const res = await request
      .put(`/api/sessions/${sessionId}/worktree-branch`)
      .send({ branch: 'feature/existing-work' })
      .expect(200);
    expect((res.body as SessionBody).worktree_checkout_branch).toBe('feature/existing-work');

    // Persisted, so a later GET reflects the choice.
    const detail = await request.get(`/api/sessions/${sessionId}`).expect(200);
    expect((detail.body as SessionBody).worktree_checkout_branch).toBe('feature/existing-work');
  });

  it('clears the choice when branch is null', async () => {
    const sessionId = await freshWorktreeSession();

    await request
      .put(`/api/sessions/${sessionId}/worktree-branch`)
      .send({ branch: 'feature/foo' })
      .expect(200);
    const cleared = await request
      .put(`/api/sessions/${sessionId}/worktree-branch`)
      .send({ branch: null })
      .expect(200);
    expect((cleared.body as SessionBody).worktree_checkout_branch ?? null).toBeNull();
  });

  it('rejects unsafe branch names (leading dash, "..") with 400 and does not mutate', async () => {
    const sessionId = await freshWorktreeSession();

    await request
      .put(`/api/sessions/${sessionId}/worktree-branch`)
      .send({ branch: '-oops' })
      .expect(400);
    await request
      .put(`/api/sessions/${sessionId}/worktree-branch`)
      .send({ branch: 'feature/../etc' })
      .expect(400);
    await request
      .put(`/api/sessions/${sessionId}/worktree-branch`)
      .send({ branch: '' })
      .expect(400);

    const detail = await request.get(`/api/sessions/${sessionId}`).expect(200);
    expect((detail.body as SessionBody).worktree_checkout_branch ?? null).toBeNull();
  });

  it('returns 400 when the session does not use a worktree', async () => {
    const sessionId = await freshWorktreeSession();
    getDb().prepare('UPDATE sessions SET use_worktree = 0 WHERE id = ?').run(sessionId);

    await request
      .put(`/api/sessions/${sessionId}/worktree-branch`)
      .send({ branch: 'feature/foo' })
      .expect(400);
  });

  it('returns 409 once the worktree has been provisioned (branch is locked)', async () => {
    const sessionId = await freshWorktreeSession();
    getDb()
      .prepare('UPDATE sessions SET worktree_path = ?, worktree_branch = ? WHERE id = ?')
      .run('/tmp/some/worktree', 'agent-hub/x/session-y', sessionId);

    await request
      .put(`/api/sessions/${sessionId}/worktree-branch`)
      .send({ branch: 'feature/foo' })
      .expect(409);
  });

  it('returns 404 for an unknown session', async () => {
    await request
      .put(`/api/sessions/does-not-exist/worktree-branch`)
      .send({ branch: 'feature/foo' })
      .expect(404);
  });
});
