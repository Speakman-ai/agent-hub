import type supertest from 'supertest';
import { getRequest, createProject, createAgent, createSession } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// Defense-in-depth: cards created or updated with a `session_id` that
// belongs to an *intake-role* agent must have that session_id (and any
// accompanying assignee) stripped server-side. Background:
//
//   - Intake sessions are ephemeral. They file a ticket on behalf of the
//     user and exit immediately.
//   - If the intake session stamps its id on the new card, the UI hides
//     the Assignee dropdown (it gates on session_id being null) and the
//     autonomous dispatcher refuses to pick up the card because it looks
//     "already in flight".
//   - Result: the entire user-request backlog freezes — exactly the
//     "Tickets all assigned to intake agent — autonomous wont run" bug.
//
// Working agents (lead/sub specialists) MUST keep their session_id
// linkage so sidebar auto-rename and `<agenthub:close-card>` keep
// working. This is asserted by the regular createCard/createSession
// test below.
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

async function getFirstColumnId(projectId: string): Promise<string> {
  const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
  const cols = (boardRes.body as { columns: Array<{ id: string }> }).columns;
  if (!cols[0]) throw new Error('No columns');
  return cols[0].id;
}

describe('intake-role session gate on card create/update', () => {
  it('strips session_id and assignee on POST when calling session is intake', async () => {
    const project = await createProject();
    const projectId = project.id as string;

    const intakeAgent = await createAgent({
      projectId,
      role: 'intake',
      name: 'Test Intake',
    });
    const session = await createSession({ agentId: intakeAgent.id as string });
    const sessionId = session.id as string;
    expect(sessionId).toBeDefined();

    const columnId = await getFirstColumnId(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({
        title: 'Filed via intake',
        columnId,
        sessionId,
        assignee: 'Test Intake',
      })
      .expect(200);

    const body = res.body as Record<string, unknown>;
    expect(body.session_id).toBeNull();
    expect(body.assignee).toBeNull();
    expect(body.title).toBe('Filed via intake');
  });

  it('preserves session_id on POST when calling session is a regular working agent', async () => {
    const project = await createProject();
    const projectId = project.id as string;

    // No `role` → defaults to a working agent (not intake/docs/reviewer).
    const workingAgent = await createAgent({
      projectId,
      name: 'Worker Bee',
    });
    const session = await createSession({ agentId: workingAgent.id as string });
    const sessionId = session.id as string;

    const columnId = await getFirstColumnId(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({
        title: 'Linked to working agent',
        columnId,
        sessionId,
        assignee: 'Worker Bee',
      })
      .expect(200);

    const body = res.body as Record<string, unknown>;
    expect(body.session_id).toBe(sessionId);
    expect(body.assignee).toBe('Worker Bee');
  });

  it('strips session_id on PUT when client tries to set it to an intake session', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const intakeAgent = await createAgent({
      projectId,
      role: 'intake',
      name: 'Test Intake PUT',
    });
    const session = await createSession({ agentId: intakeAgent.id as string });
    const sessionId = session.id as string;
    const columnId = await getFirstColumnId(projectId);

    // Create an unassigned card first (no session_id in payload).
    const created = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'PUT update target', columnId })
      .expect(200);
    const cardId = (created.body as { id: string }).id;

    // Now try to stamp the intake session via PUT.
    const updated = await request
      .put(`/api/projects/${projectId}/board/cards/${cardId}`)
      .send({ sessionId, assignee: 'Test Intake PUT' })
      .expect(200);

    const body = updated.body as Record<string, unknown>;
    expect(body.session_id).toBeNull();
    expect(body.assignee).toBeNull();
  });

  it('honors explicit clears (sessionId: null) regardless of agent role', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const workingAgent = await createAgent({
      projectId,
      name: 'Worker Clear',
    });
    const session = await createSession({ agentId: workingAgent.id as string });
    const sessionId = session.id as string;
    const columnId = await getFirstColumnId(projectId);

    const created = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'Clearable card', columnId, sessionId, assignee: 'Worker Clear' })
      .expect(200);
    expect((created.body as { session_id: string }).session_id).toBe(sessionId);

    const cleared = await request
      .put(`/api/projects/${projectId}/board/cards/${created.body.id}`)
      .send({ sessionId: null, assignee: null })
      .expect(200);

    const body = cleared.body as Record<string, unknown>;
    expect(body.session_id).toBeNull();
    expect(body.assignee).toBeNull();
  });

  it('does not blow up when sessionId points at a non-existent session', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const columnId = await getFirstColumnId(projectId);

    // Unknown session → server can't decide it's intake-owned, so we
    // store the value verbatim. (The DB has no FK on session_id, so
    // dangling references are pre-existing accepted behavior.)
    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({
        title: 'Unknown session',
        columnId,
        sessionId: 'no-such-session-uuid',
        assignee: 'Mystery',
      })
      .expect(200);

    const body = res.body as Record<string, unknown>;
    expect(body.session_id).toBe('no-such-session-uuid');
    expect(body.assignee).toBe('Mystery');
  });
});
