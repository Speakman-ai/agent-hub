import { describe, it, expect, beforeAll } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject, createCard } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// Scoping invariant: a card linked to an epic ALWAYS lands in a phase.
//
// An epic-linked card with `phase_id = null` is invisible in the phase
// flowchart (grouped by phase_id) and the autonomous phase runner
// (dispatches by phase_id) never picks it up. So whenever a card gets an
// epic without an explicit phase, the API auto-resolves the epic's phase —
// using the first existing phase by position, or materializing a default
// "Phase 1" when the epic has none.
//   - POST /board/cards            — epicId without phaseId
//   - PUT  /board/cards/:id         — epicId set without phaseId; epic swap
//   - POST /board/cards/:id/epic    — link resolves a phase, unlink clears it
// ═══════════════════════════════════════════════════════════════════

let request: supertest.Agent;
let projectId: string;

async function createEpic(name: string): Promise<string> {
  const res = await request
    .post(`/api/projects/${projectId}/board/epics`)
    .send({ name })
    .expect(200);
  return (res.body as { id: string }).id;
}

async function createPhase(epicId: string, name: string): Promise<string> {
  const res = await request
    .post(`/api/projects/${projectId}/board/phases`)
    .send({ epicId, name })
    .expect(200);
  return (res.body as { id: string }).id;
}

async function phasesForEpic(epicId: string): Promise<Array<{ id: string; name: string }>> {
  const res = await request.get(`/api/projects/${projectId}/board/phases`).expect(200);
  return (res.body as Array<{ id: string; epic_id: string; name: string }>).filter(
    (p) => p.epic_id === epicId,
  );
}

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
});

describe('POST /board/cards — auto-phase on epic link', () => {
  it('materializes a default phase when linking a card to a phase-less epic', async () => {
    const epicId = await createEpic('Fresh epic');
    expect(await phasesForEpic(epicId)).toHaveLength(0);

    const card = await createCard(projectId, { title: 'auto-phase-create', epicId });
    expect((card as { epic_id: string }).epic_id).toBe(epicId);
    expect((card as { phase_id: string | null }).phase_id).not.toBeNull();

    const phases = await phasesForEpic(epicId);
    expect(phases).toHaveLength(1);
    expect(phases[0].name).toBe('Phase 1');
    expect((card as { phase_id: string }).phase_id).toBe(phases[0].id);
  });

  it('joins the existing phase when the epic already has one', async () => {
    const epicId = await createEpic('One-phase epic');
    const phaseId = await createPhase(epicId, 'Only phase');

    const card = await createCard(projectId, { title: 'auto-phase-existing', epicId });
    expect((card as { phase_id: string }).phase_id).toBe(phaseId);
    // No extra phase was created.
    expect(await phasesForEpic(epicId)).toHaveLength(1);
  });

  it('joins the first phase by position for a multi-phase epic', async () => {
    const epicId = await createEpic('Multi-phase epic');
    const first = await createPhase(epicId, 'Phase A');
    await createPhase(epicId, 'Phase B');

    const card = await createCard(projectId, { title: 'auto-phase-first', epicId });
    expect((card as { phase_id: string }).phase_id).toBe(first);
  });

  it('respects an explicit phaseId and does not override it', async () => {
    const epicId = await createEpic('Explicit-phase epic');
    await createPhase(epicId, 'Phase X');
    const target = await createPhase(epicId, 'Phase Y');

    const card = await createCard(projectId, { title: 'explicit-phase', epicId, phaseId: target });
    expect((card as { phase_id: string }).phase_id).toBe(target);
  });

  it('leaves an unlinked card (no epic) phase-less', async () => {
    const card = await createCard(projectId, { title: 'no-epic-no-phase' });
    expect((card as { epic_id: string | null }).epic_id).toBeNull();
    expect((card as { phase_id: string | null }).phase_id).toBeNull();
  });
});

describe('PUT /board/cards/:id — auto-phase reconciliation', () => {
  it('auto-phases a card when an epic is set without a phase', async () => {
    const epicId = await createEpic('Put-set-epic');
    const phaseId = await createPhase(epicId, 'Put phase');
    const card = await createCard(projectId, { title: 'put-auto-phase' });
    expect((card as { phase_id: string | null }).phase_id).toBeNull();

    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id as string}`)
      .send({ epicId })
      .expect(200);
    const updated = res.body as { epic_id: string; phase_id: string };
    expect(updated.epic_id).toBe(epicId);
    expect(updated.phase_id).toBe(phaseId);
  });

  it('drops a stale phase and re-phases when the epic changes', async () => {
    const epicA = await createEpic('Swap-A');
    const phaseA = await createPhase(epicA, 'A phase');
    const epicB = await createEpic('Swap-B');
    const phaseB = await createPhase(epicB, 'B phase');

    const card = await createCard(projectId, { title: 'epic-swap', epicId: epicA });
    expect((card as { phase_id: string }).phase_id).toBe(phaseA);

    // Move to epic B with no phaseId — the epic-A phase is stale and must be
    // replaced by epic B's phase, never left pointing across epics.
    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id as string}`)
      .send({ epicId: epicB })
      .expect(200);
    const updated = res.body as { epic_id: string; phase_id: string };
    expect(updated.epic_id).toBe(epicB);
    expect(updated.phase_id).toBe(phaseB);
  });

  it('clears the phase when the epic is cleared', async () => {
    const epicId = await createEpic('Clear-epic');
    await createPhase(epicId, 'Clear phase');
    const card = await createCard(projectId, { title: 'clear-epic-phase', epicId });
    expect((card as { phase_id: string | null }).phase_id).not.toBeNull();

    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id as string}`)
      .send({ epicId: null })
      .expect(200);
    const updated = res.body as { epic_id: string | null; phase_id: string | null };
    expect(updated.epic_id).toBeNull();
    expect(updated.phase_id).toBeNull();
  });

  it('honors an explicit phaseId: null clear even while an epic stays linked', async () => {
    const epicId = await createEpic('Explicit-clear');
    await createPhase(epicId, 'Some phase');
    const card = await createCard(projectId, { title: 'explicit-clear-phase', epicId });
    expect((card as { phase_id: string | null }).phase_id).not.toBeNull();

    const res = await request
      .put(`/api/projects/${projectId}/board/cards/${card.id as string}`)
      .send({ phaseId: null })
      .expect(200);
    const updated = res.body as { epic_id: string; phase_id: string | null };
    expect(updated.epic_id).toBe(epicId);
    expect(updated.phase_id).toBeNull();
  });
});

describe('POST /board/cards/:id/epic — auto-phase on link/unlink', () => {
  it('resolves a phase when linking a card to an epic', async () => {
    const epicId = await createEpic('Link-epic');
    const phaseId = await createPhase(epicId, 'Link phase');
    const card = await createCard(projectId, { title: 'link-endpoint-phase' });

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id as string}/epic`)
      .send({ epicId })
      .expect(200);
    const updated = res.body as { epic_id: string; phase_id: string };
    expect(updated.epic_id).toBe(epicId);
    expect(updated.phase_id).toBe(phaseId);
  });

  it('clears the phase when unlinking the epic', async () => {
    const epicId = await createEpic('Unlink-epic');
    await createPhase(epicId, 'Unlink phase');
    const card = await createCard(projectId, { title: 'unlink-endpoint-phase', epicId });
    expect((card as { phase_id: string | null }).phase_id).not.toBeNull();

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id as string}/epic`)
      .send({ epicId: null })
      .expect(200);
    const updated = res.body as { epic_id: string | null; phase_id: string | null };
    expect(updated.epic_id).toBeNull();
    expect(updated.phase_id).toBeNull();
  });

  it('re-phases into the target epic when moving between epics', async () => {
    const epicA = await createEpic('Move-src');
    await createPhase(epicA, 'src phase');
    const epicB = await createEpic('Move-dst');
    const phaseB = await createPhase(epicB, 'dst phase');
    const card = await createCard(projectId, { title: 'move-endpoint-phase', epicId: epicA });

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${card.id as string}/epic`)
      .send({ epicId: epicB })
      .expect(200);
    const updated = res.body as { epic_id: string; phase_id: string };
    expect(updated.epic_id).toBe(epicB);
    expect(updated.phase_id).toBe(phaseB);
  });
});
