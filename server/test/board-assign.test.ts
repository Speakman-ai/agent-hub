import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type supertest from 'supertest';

/** Hoisted so `vi.mock` factory can attach a stable spy before `../index.js` loads. */
const mockGetDevHubApiKey = vi.hoisted(() =>
  vi.fn(async (): Promise<string | null> => 'ahub_board_assign_fixture'),
);

vi.mock('../secrets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../secrets.js')>();
  return {
    ...actual,
    getDevHubApiKey: mockGetDevHubApiKey,
  };
});

import { getRequest, createProject, createAgent, createCard } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

beforeEach(() => {
  mockGetDevHubApiKey.mockClear();
  mockGetDevHubApiKey.mockImplementation(async () => 'ahub_board_assign_fixture');
});

describe('POST /api/projects/:projectId/board/cards/:cardId/assign', () => {
  it('assigns a regular agent with standard prompt', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId });
    const agentId = agent.id as string;
    const card = await createCard(projectId, {
      title: 'Build auth module',
      description: 'Implement JWT auth',
    });
    const cardId = card.id as string;

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${cardId}/assign`)
      .send({ agentId })
      .expect(200);

    expect(res.body.sessionId).toBeDefined();
    expect(res.body.card.assignee).toBe(agent.name);
    expect(res.body.card.session_id).toBe(res.body.sessionId);
    expect((res.body.card as { assign_model?: string | null }).assign_model).toBeNull();
  });

  it('accepts optional model override on assign and persists it on the card + session', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({
      projectId,
      model: 'claude-opus-4-7',
    });
    const agentId = agent.id as string;
    const card = await createCard(projectId, { title: 'Model override card' });
    const cardId = card.id as string;
    const override = 'claude-sonnet-4-6';

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${cardId}/assign`)
      .send({ agentId, model: override })
      .expect(200);

    expect((res.body.card as { assign_model: string | null }).assign_model).toBe(override);
    const sessionRes = await request.get(`/api/sessions/${res.body.sessionId}`).expect(200);
    expect(sessionRes.body.model).toBe(override);
  });

  it('falls back to agent model when assign body omits model', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const fixed = 'claude-opus-4-7';
    const agent = await createAgent({ projectId, model: fixed });
    const card = await createCard(projectId, { title: 'Default model card' });

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/assign`)
      .send({ agentId: agent.id })
      .expect(200);

    expect((res.body.card as { assign_model?: string | null }).assign_model).toBeNull();
    const sessionRes = await request.get(`/api/sessions/${res.body.sessionId}`).expect(200);
    expect(sessionRes.body.model).toBe(fixed);
  });

  it('assigns an intake agent with ticket research prompt (no PR instructions)', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({
      projectId,
      role: 'intake',
      name: 'Ticket Intake',
    });
    const agentId = agent.id as string;
    const card = await createCard(projectId, {
      title: 'Design new dashboard',
      description: 'Plan the new dashboard layout and features',
    });
    const cardId = card.id as string;

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${cardId}/assign`)
      .send({ agentId })
      .expect(200);

    expect(res.body.sessionId).toBeDefined();
    expect(res.body.card.assignee).toBe('Ticket Intake');

    // Verify the session was created (the intake prompt is sent via handleChat,
    // which we can't easily inspect in an integration test, but the session exists)
    const sessionRes = await request.get(`/api/sessions/${res.body.sessionId}`).expect(200);
    expect(sessionRes.body.name).toBe('Design new dashboard');
  });

  it('returns 404 for missing card', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId });

    await request
      .post(`/api/projects/${projectId}/board/cards/nonexistent/assign`)
      .send({ agentId: agent.id })
      .expect(404);
  });

  it('returns 400 when agentId is missing', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const card = await createCard(projectId);

    await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/assign`)
      .send({})
      .expect(400);
  });

  it('returns 404 for unknown agent', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const card = await createCard(projectId);

    await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/assign`)
      .send({ agentId: 'ghost-agent' })
      .expect(404);
  });

  it('returns 400 when model override is not valid for the agent engine', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId });
    const card = await createCard(projectId, { title: 'Bad model card' });

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/assign`)
      .send({ agentId: agent.id, model: 'gpt-5.3-codex-high' })
      .expect(400);

    expect((res.body as { error?: string }).error).toContain('not valid for engine');
  });

  it('calls getDevHubApiKey when card has cross-hub:dev label (manual assign)', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId });
    const card = await createCard(projectId, {
      title: 'Cross-hub task',
      labels: 'cross-hub:dev,infra',
    });

    await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/assign`)
      .send({ agentId: agent.id })
      .expect(200);

    expect(mockGetDevHubApiKey).toHaveBeenCalledTimes(1);
  });

  it('calls getDevHubApiKey when card has survey-tracker label (manual assign)', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId });
    const card = await createCard(projectId, {
      title: 'Tracker task',
      labels: 'survey-tracker',
    });

    await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/assign`)
      .send({ agentId: agent.id })
      .expect(200);

    expect(mockGetDevHubApiKey).toHaveBeenCalledTimes(1);
  });

  it('does not call getDevHubApiKey when card lacks opt-in labels', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId });
    const card = await createCard(projectId, {
      title: 'Plain task',
      labels: 'infra,backend',
    });

    await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/assign`)
      .send({ agentId: agent.id })
      .expect(200);

    expect(mockGetDevHubApiKey).not.toHaveBeenCalled();
  });
});

describe('POST /api/projects/:projectId/board/cards/:cardId/unassign', () => {
  it('clears assignee and session_id after a prior /assign', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId });
    const agentId = agent.id as string;
    const card = await createCard(projectId, {
      title: 'Round-trip assign then unassign',
    });
    const cardId = card.id as string;

    // Assign → card should now have an assignee and a session_id.
    const assignRes = await request
      .post(`/api/projects/${projectId}/board/cards/${cardId}/assign`)
      .send({ agentId })
      .expect(200);
    expect(assignRes.body.card.assignee).toBe(agent.name);
    expect(assignRes.body.card.session_id).toBe(assignRes.body.sessionId);

    // Unassign → both assignee and session_id are null, other fields preserved.
    const unassignRes = await request
      .post(`/api/projects/${projectId}/board/cards/${cardId}/unassign`)
      .send({})
      .expect(200);
    expect(unassignRes.body.assignee).toBeNull();
    expect(unassignRes.body.session_id).toBeNull();
    expect((unassignRes.body as { assign_model?: string | null }).assign_model).toBeNull();
    expect(unassignRes.body.title).toBe('Round-trip assign then unassign');
  });

  it('clears assign_model after assign used a model override', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId });
    const card = await createCard(projectId);
    const override = 'claude-sonnet-4-6';

    const assignRes = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/assign`)
      .send({ agentId: agent.id, model: override })
      .expect(200);
    expect((assignRes.body.card as { assign_model: string }).assign_model).toBe(override);

    const unassignRes = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/unassign`)
      .send({})
      .expect(200);
    expect((unassignRes.body as { assign_model?: string | null }).assign_model).toBeNull();
  });

  it('is a no-op-safe when called on an already-unassigned card', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const card = await createCard(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/unassign`)
      .send({})
      .expect(200);
    expect(res.body.assignee).toBeNull();
    expect(res.body.session_id).toBeNull();
  });

  it('returns 404 for missing card', async () => {
    const project = await createProject();
    const projectId = project.id as string;

    await request
      .post(`/api/projects/${projectId}/board/cards/nonexistent/unassign`)
      .send({})
      .expect(404);
  });
});

// ─── Spawn env — AGENT_HUB_URL and PROJECT_ID injection ────────────────────
// Verified at the unit level in server-port.test.ts (getActualPort fallback)
// and by source inspection: chat.ts lines that set base.AGENT_HUB_URL and
// base.PROJECT_ID immediately before `return base` in the spawn env block.
// Integration-level verification that spawn fires is covered by the existing
// assign tests which confirm a session row is created; the env var injection
// path is exercised whenever chat.ts runs handleChat for a kanban-assigned card.
