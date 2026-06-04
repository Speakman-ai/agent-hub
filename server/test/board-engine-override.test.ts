import { describe, it, expect, beforeAll } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject, createAgent, createCard } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// PUT /api/projects/:projectId/board/cards/:cardId — `assign_engine`
// override (paired with `assign_model`).
//
// The engine selector + model selector dropdown introduced for card
// dfbc6a6c ("Ticket Session-Model picker limited to assignee engine")
// posts both fields via PUT when editing an already-assigned card. The
// server must:
//
//   1. Validate the engine against `cfg.engineValidModels` keys (unknown
//      engine → 400).
//   2. Validate the model against the *override* engine, not the
//      assignee agent's shared engine — otherwise a cross-engine combo
//      like { engine: codex-cli, model: gpt-5.3-codex } gets rejected
//      because gpt-5.3-codex isn't valid for claude-code.
//   3. Persist both columns; subsequent reads must round-trip them.
//   4. POST /unassign clears both `assign_engine` and `assign_model`.
//
// These cases also exercise the dual-validation path: if only the model
// is sent and a previous PUT already pinned an engine, the validator
// must use the persisted engine, not the agent's shared engine.
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('PUT board card — assign_engine + assign_model override', () => {
  it('accepts paired engine + model override and persists both', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId, engine: 'claude-code' });
    const card = await createCard(projectId, { title: 'PUT engine override' });

    // Assign first so the card has an `assignee` row to validate against.
    await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/assign`)
      .send({ agentId: agent.id })
      .expect(200);

    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ assign_engine: 'codex-cli', assign_model: 'gpt-5.4' })
      .expect(200);

    const out = res.body as { assign_engine: string | null; assign_model: string | null };
    expect(out.assign_engine).toBe('codex-cli');
    expect(out.assign_model).toBe('gpt-5.4');
  });

  it('rejects an unknown engine id with 400 and does not mutate the row', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId });
    const card = await createCard(projectId, { title: 'PUT bad engine' });
    await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/assign`)
      .send({ agentId: agent.id })
      .expect(200);

    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ assign_engine: 'not-a-real-engine' })
      .expect(400);

    expect((res.body as { error?: string }).error).toContain('Invalid engine');

    // Confirm the row is untouched — fetch via the board listing.
    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const cards = (boardRes.body as { cards: Array<{ id: string; assign_engine: string | null }> })
      .cards;
    const found = cards.find((c) => c.id === card.id);
    expect(found?.assign_engine ?? null).toBeNull();
  });

  it('validates the model against the override engine, not the assignee engine', async () => {
    // The assignee is claude-code. With ONLY `assign_model` posted but a
    // previous PUT having already pinned `assign_engine = codex-cli`, the
    // validator must use codex-cli for model validation. Without this
    // (the pre-fix branch), the validator falls back to the agent engine
    // and a valid codex model gets rejected as "not valid for claude-code".
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId, engine: 'claude-code' });
    const card = await createCard(projectId, { title: 'Two-step override' });
    await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/assign`)
      .send({ agentId: agent.id })
      .expect(200);

    // Step 1: pin the engine.
    await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ assign_engine: 'codex-cli' })
      .expect(200);

    // Step 2: change ONLY the model — must be validated against codex-cli.
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ assign_model: 'gpt-5.4' })
      .expect(200);

    expect((res.body as { assign_model: string | null }).assign_model).toBe('gpt-5.4');
    expect((res.body as { assign_engine: string | null }).assign_engine).toBe('codex-cli');
  });

  it('clearing assign_engine to null falls back to assignee-engine validation', async () => {
    // After clearing the engine override, a model that's only valid for
    // the previously-set override engine must be rejected when the
    // agent's shared engine no longer accepts it. Mirrors the original
    // pre-engine-override behaviour.
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId, engine: 'claude-code' });
    const card = await createCard(projectId, { title: 'Clear engine override' });
    await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/assign`)
      .send({ agentId: agent.id, engine: 'codex-cli', model: 'gpt-5.4' })
      .expect(200);

    // Posting both fields together: clear the engine but try to keep a
    // codex model. Must 400 because gpt-5.4 is not valid for
    // claude-code.
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id}`)
      .send({ assign_engine: null, assign_model: 'gpt-5.4' })
      .expect(400);
    expect((res.body as { error?: string }).error).toContain('not valid for engine');
  });
});

describe('POST /unassign clears assign_engine alongside assign_model', () => {
  it('nulls both override columns after a prior cross-engine assign', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId, engine: 'claude-code' });
    const card = await createCard(projectId);

    const assignRes = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/assign`)
      .send({ agentId: agent.id, engine: 'codex-cli', model: 'gpt-5.4' })
      .expect(200);
    expect((assignRes.body.card as { assign_engine: string | null }).assign_engine).toBe(
      'codex-cli',
    );

    const unassignRes = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/unassign`)
      .send({})
      .expect(200);
    expect((unassignRes.body as { assign_engine: string | null }).assign_engine).toBeNull();
    expect((unassignRes.body as { assign_model: string | null }).assign_model).toBeNull();
  });
});
