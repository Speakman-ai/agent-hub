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
      model: 'claude-opus-4-8',
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
    const fixed = 'claude-opus-4-8';
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

  it('accepts an engine override + model from the override engine and persists both', async () => {
    // A claude-code agent + an engine override to codex-cli with a codex
    // model. The spawned session must use the override engine + model, NOT
    // the agent's shared engine. This is the core path for the Kanban
    // engine + model dropdown introduced for card dfbc6a6c.
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId, engine: 'claude-code' });
    const card = await createCard(projectId, { title: 'Cross-engine card' });

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/assign`)
      .send({ agentId: agent.id, engine: 'codex-cli', model: 'gpt-5.3-codex' })
      .expect(200);

    const cardOut = res.body.card as { assign_model: string | null; assign_engine: string | null };
    expect(cardOut.assign_engine).toBe('codex-cli');
    expect(cardOut.assign_model).toBe('gpt-5.3-codex');
    const sessionRes = await request.get(`/api/sessions/${res.body.sessionId}`).expect(200);
    expect(sessionRes.body.engine).toBe('codex-cli');
    expect(sessionRes.body.model).toBe('gpt-5.3-codex');
  });

  it('returns 400 for an unknown engine override', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId });
    const card = await createCard(projectId, { title: 'Bad engine card' });

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/assign`)
      .send({ agentId: agent.id, engine: 'not-a-real-engine' })
      .expect(400);

    expect((res.body as { error?: string }).error).toContain('Invalid engine');
  });

  it('rejects a model that is not valid for the override engine', async () => {
    // Engine override = codex-cli, but model is a claude-code id. The
    // engine-keyed validator must reject — otherwise the spawn would start
    // codex-cli with a non-existent model id and stall.
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId, engine: 'claude-code' });
    const card = await createCard(projectId, { title: 'Mismatched model card' });

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/assign`)
      .send({ agentId: agent.id, engine: 'codex-cli', model: 'claude-opus-4-8' })
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

// ─── Spawn env — AGENT_HUB_URL / resolveAgentHubApiBaseForSpawn + PROJECT_ID injection ────────────────────
// Verified via config.test.ts plus source: chat.ts sets base.AGENT_HUB_URL from
// resolveAgentHubApiBaseForSpawn(config) and base.PROJECT_ID before `return base`
// in the spawn env builder.
