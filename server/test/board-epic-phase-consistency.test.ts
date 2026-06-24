import type supertest from 'supertest';
import { getRequest, createProject, createCard } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// Epic ↔ phase ↔ project consistency in board.ts routes
//
// A phase belongs to exactly one epic, and a phase belongs to exactly
// one project's board. These tests pin three holes:
//   - POST /board/cards     — epicId + phaseId from a different epic
//   - PUT  /board/cards/:id  — setting a phase reconciles epic_id
//   - PUT/DELETE /board/phases/:id — cross-project phase mutation
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;
let projectId: string;
let columnId: string;
let epicA: string;
let epicB: string;
let phaseUnderA: string;

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

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
  const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
  columnId = (boardRes.body as { columns: Array<{ id: string }> }).columns[0].id;
  epicA = await createEpic(projectId, 'Epic A');
  epicB = await createEpic(projectId, 'Epic B');
  phaseUnderA = await createPhase(projectId, epicA, 'Phase under A');
});

async function boardCardTitles(proj: string): Promise<string[]> {
  const res = await request.get(`/api/projects/${proj}/board`).expect(200);
  return (res.body as { cards: Array<{ title: string }> }).cards.map((c) => c.title);
}

describe('POST /board/cards — epic/phase scope reconciliation', () => {
  it('rejects a card whose epicId disagrees with the phase epic and leaves no orphan card', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'split-scope', columnId, epicId: epicB, phaseId: phaseUnderA })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/different epic/i);
    // Validation runs BEFORE the insert — the rejected request must not leave
    // a card behind.
    expect(await boardCardTitles(projectId)).not.toContain('split-scope');
  });

  it('rejects a missing/foreign phaseId with 404 and leaves no orphan card', async () => {
    const other = await createProject();
    const otherEpic = await createEpic(other.id as string, 'Other epic for phase');
    const foreignPhase = await createPhase(other.id as string, otherEpic, 'Foreign phase');

    await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'foreign-phase-card', columnId, phaseId: foreignPhase })
      .expect(404);
    expect(await boardCardTitles(projectId)).not.toContain('foreign-phase-card');

    await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'ghost-phase-card', columnId, phaseId: 'no-such-phase' })
      .expect(404);
    expect(await boardCardTitles(projectId)).not.toContain('ghost-phase-card');
  });

  it('derives the epic from the phase when only phaseId is supplied', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'phase-only', columnId, phaseId: phaseUnderA })
      .expect(200);
    const card = res.body as { epic_id: string; phase_id: string };
    expect(card.phase_id).toBe(phaseUnderA);
    expect(card.epic_id).toBe(epicA);
  });

  it('keeps the consistent epic when epicId matches the phase epic', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'consistent', columnId, epicId: epicA, phaseId: phaseUnderA })
      .expect(200);
    const card = res.body as { epic_id: string; phase_id: string };
    expect(card.epic_id).toBe(epicA);
    expect(card.phase_id).toBe(phaseUnderA);
  });
});

describe('PUT /board/cards/:cardId — epic/phase scope reconciliation', () => {
  it('forces epic_id to the phase epic when a card in another epic gets the phase', async () => {
    // Card starts scoped to epic B…
    const card = await createCard(projectId, { title: 'reassign-scope', epicId: epicB });
    expect((card as { epic_id: string }).epic_id).toBe(epicB);
    // …then is assigned a phase that belongs to epic A. The card's epic must
    // follow the phase so the epic UI and phase dispatch agree.
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id as string}`)
      .send({ phaseId: phaseUnderA })
      .expect(200);
    const updated = res.body as { epic_id: string; phase_id: string };
    expect(updated.phase_id).toBe(phaseUnderA);
    expect(updated.epic_id).toBe(epicA);
  });

  it('rejects an explicit epicId that disagrees with the phase epic', async () => {
    const card = await createCard(projectId, { title: 'conflict-update' });
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id as string}`)
      .send({ epicId: epicB, phaseId: phaseUnderA })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/different epic/i);
  });
});

describe('PUT/DELETE /board/phases/:phaseId — project scoping', () => {
  it('refuses to update a phase that belongs to a different project', async () => {
    const other = await createProject();
    const otherProjectId = other.id as string;
    const otherEpic = await createEpic(otherProjectId, 'Other epic');
    const foreignPhase = await createPhase(otherProjectId, otherEpic, 'Foreign phase');

    // Try to mutate the foreign phase through THIS project's URL.
    await request
      .put(`/api/projects/${projectId}/board/phases/${foreignPhase}`)
      .send({ name: 'hijacked', autonomous: 1 })
      .expect(404);

    // The foreign phase is untouched.
    const check = await request.get(`/api/projects/${otherProjectId}/board/phases`).expect(200);
    const phase = (check.body as Array<{ id: string; name: string; autonomous: number }>).find(
      (p) => p.id === foreignPhase,
    );
    expect(phase?.name).toBe('Foreign phase');
    expect(phase?.autonomous).toBeFalsy();
  });

  it('refuses to delete a phase that belongs to a different project', async () => {
    const other = await createProject();
    const otherProjectId = other.id as string;
    const otherEpic = await createEpic(otherProjectId, 'Other epic 2');
    const foreignPhase = await createPhase(otherProjectId, otherEpic, 'Foreign phase 2');

    await request.delete(`/api/projects/${projectId}/board/phases/${foreignPhase}`).expect(404);

    // Still present in its own project.
    const check = await request.get(`/api/projects/${otherProjectId}/board/phases`).expect(200);
    const stillThere = (check.body as Array<{ id: string }>).some((p) => p.id === foreignPhase);
    expect(stillThere).toBe(true);
  });
});
