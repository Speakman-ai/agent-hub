import type supertest from 'supertest';
import { getRequest, createProject, createAgent } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// Spec-item scope & decision validation in board.ts routes
//
//   - POST /board/spec-items     — phaseId must be on-board + same epic
//   - PUT  /board/spec-items/:id — `chosen` requires a non-empty decision
//
// (decide-for-me agent-membership is owner-gated, so it's covered in
//  board-decide-for-me-agent.test.ts with a stub-auth mini-app.)
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;
let projectId: string;
let epicA: string;
let epicB: string;
let phaseUnderB: string;

async function createEpic(proj: string, name: string): Promise<string> {
  const res = await request.post(`/api/projects/${proj}/board/epics`).send({ name }).expect(200);
  return (res.body as { id: string }).id;
}

async function createPhase(proj: string, epicId: string, name: string): Promise<string> {
  const res = await request
    .post(`/api/projects/${proj}/board/phases`)
    .send({ epicId, name })
    .expect(200);
  return (res.body as { id: string }).id;
}

async function createSpecItem(
  proj: string,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await request.post(`/api/projects/${proj}/board/spec-items`).send(body).expect(200);
  return res.body as { id: string };
}

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
  // Ensure the project has at least one agent for the default decide path.
  await createAgent({ projectId });
  epicA = await createEpic(projectId, 'Spec Epic A');
  epicB = await createEpic(projectId, 'Spec Epic B');
  phaseUnderB = await createPhase(projectId, epicB, 'Phase under B');
});

describe('POST /board/spec-items — phase scope validation', () => {
  it('rejects a phaseId that belongs to a different epic', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/board/spec-items`)
      .send({ epicId: epicA, tag: 'CHOOSE', title: 'cross-epic phase', phaseId: phaseUnderB })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/valid phase/i);
  });

  it('rejects a foreign phaseId even with createSpikeCard', async () => {
    const otherProject = await createProject();
    const otherEpic = await createEpic(otherProject.id as string, 'Foreign epic');
    const foreignPhase = await createPhase(otherProject.id as string, otherEpic, 'Foreign phase');

    const res = await request
      .post(`/api/projects/${projectId}/board/spec-items`)
      .send({
        epicId: epicA,
        tag: 'CHOOSE',
        title: 'foreign phase spike',
        phaseId: foreignPhase,
        createSpikeCard: true,
      })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/valid phase/i);
  });

  it('accepts a phase that belongs to the spec item epic', async () => {
    const item = await createSpecItem(projectId, {
      epicId: epicB,
      tag: 'CHOOSE',
      title: 'consistent phase',
      phaseId: phaseUnderB,
    });
    expect(item.id).toBeTruthy();
  });
});

describe('PUT /board/spec-items/:id — chosen requires a decision', () => {
  it('rejects status=chosen when no decision text is present', async () => {
    const item = await createSpecItem(projectId, {
      epicId: epicA,
      tag: 'CHOOSE',
      title: 'undecided',
    });
    const res = await request
      .put(`/api/projects/${projectId}/board/spec-items/${item.id}`)
      .send({ status: 'chosen' })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/decision is required/i);
  });

  it('rejects status=chosen when the decision is whitespace only', async () => {
    const item = await createSpecItem(projectId, {
      epicId: epicA,
      tag: 'CHOOSE',
      title: 'whitespace decision',
    });
    const res = await request
      .put(`/api/projects/${projectId}/board/spec-items/${item.id}`)
      .send({ status: 'chosen', decision: '   ' })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/decision is required/i);
  });

  it('locks to chosen when a real decision is supplied', async () => {
    const item = await createSpecItem(projectId, {
      epicId: epicA,
      tag: 'CHOOSE',
      title: 'decided',
    });
    const res = await request
      .put(`/api/projects/${projectId}/board/spec-items/${item.id}`)
      .send({ status: 'chosen', decision: 'Use WebSocket streaming.' })
      .expect(200);
    const body = res.body as { status: string; decision: string };
    expect(body.status).toBe('chosen');
    expect(body.decision).toBe('Use WebSocket streaming.');
  });
});

describe('POST /board/spec-items — status on create', () => {
  it('creates an already-chosen item when a decision is supplied', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/board/spec-items`)
      .send({
        epicId: epicA,
        tag: 'CHOOSE',
        title: 'decided on create',
        status: 'chosen',
        decision: 'Adopt the queue-based fan-out.',
      })
      .expect(200);
    const body = res.body as { status: string; decision: string };
    expect(body.status).toBe('chosen');
    expect(body.decision).toBe('Adopt the queue-based fan-out.');
  });

  it('rejects status=chosen on create without a decision', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/board/spec-items`)
      .send({ epicId: epicA, tag: 'CHOOSE', title: 'chosen no decision', status: 'chosen' })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/decision is required/i);
  });

  it('defaults to open when no status is supplied', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/board/spec-items`)
      .send({ epicId: epicA, tag: 'CHOOSE', title: 'defaults open', decision: 'noted' })
      .expect(200);
    expect((res.body as { status: string }).status).toBe('open');
  });
});

describe('spec-items — blank phaseId normalization', () => {
  it('stores NULL (not an empty string) for a blank phaseId on create', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/board/spec-items`)
      .send({ epicId: epicA, tag: 'CHOOSE', title: 'blank phase create', phaseId: '' })
      .expect(200);
    expect((res.body as { phase_id: string | null }).phase_id).toBeNull();
  });

  it('clears phase to NULL (not an empty string) for a blank phaseId on update', async () => {
    const item = (await createSpecItem(projectId, {
      epicId: epicB,
      tag: 'CHOOSE',
      title: 'blank phase update',
      phaseId: phaseUnderB,
    })) as { id: string; phase_id: string | null };
    expect(item.phase_id).toBe(phaseUnderB);

    const upd = await request
      .put(`/api/projects/${projectId}/board/spec-items/${item.id}`)
      .send({ phaseId: '' })
      .expect(200);
    expect((upd.body as { phase_id: string | null }).phase_id).toBeNull();
  });
});

describe('DELETE /board/spec-items/:id — removes the linked spike card', () => {
  async function boardCards(): Promise<Array<{ id: string }>> {
    const res = await request.get(`/api/projects/${projectId}/board`).expect(200);
    return (res.body as { cards: Array<{ id: string }> }).cards;
  }

  it('deletes the orphan spike card so the decision cannot resurrect', async () => {
    const item = (await createSpecItem(projectId, {
      epicId: epicA,
      tag: 'CHOOSE',
      title: 'spike to delete',
      createSpikeCard: true,
    })) as { id: string; spike_card_id: string | null };
    expect(item.spike_card_id).toBeTruthy();
    const spikeCardId = item.spike_card_id as string;

    expect((await boardCards()).some((c) => c.id === spikeCardId)).toBe(true);

    await request.delete(`/api/projects/${projectId}/board/spec-items/${item.id}`).expect(200);

    // The spike card is gone — no orphan left to be re-dispatched and re-spec'd.
    expect((await boardCards()).some((c) => c.id === spikeCardId)).toBe(false);
  });
});
