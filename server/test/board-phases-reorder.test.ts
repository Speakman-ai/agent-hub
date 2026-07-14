import { describe, it, expect, beforeAll } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject, createCard } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════
// POST /board/phases/reorder — explicit permutation and auto topo-sort.
//
// No reorder path existed for phases, so an epic authored in narrative
// order (foundation last) could deadlock the autonomous cascade with no
// way to correct positions. This endpoint mirrors columns/reorder and
// adds a `sortByDependencies` mode that derives the order from the card
// blocker graph.
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

async function phasesForEpic(
  epicId: string,
): Promise<Array<{ id: string; name: string; position: number }>> {
  const res = await request.get(`/api/projects/${projectId}/board/phases`).expect(200);
  return (res.body as Array<{ id: string; epic_id: string; name: string; position: number }>)
    .filter((p) => p.epic_id === epicId)
    .sort((a, b) => a.position - b.position);
}

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
});

describe('POST /board/phases/reorder — explicit order', () => {
  it('rewrites positions to the supplied order and persists them', async () => {
    const epicId = await createEpic('Explicit reorder epic');
    const p1 = await createPhase(epicId, 'First');
    const p2 = await createPhase(epicId, 'Second');
    const p3 = await createPhase(epicId, 'Third');

    // Sanity: created in authored order 0,1,2.
    expect((await phasesForEpic(epicId)).map((p) => p.id)).toEqual([p1, p2, p3]);

    const res = await request
      .post(`/api/projects/${projectId}/board/phases/reorder`)
      .send({ epicId, phaseIds: [p3, p1, p2] })
      .expect(200);

    const returned = (res.body as Array<{ id: string; position: number }>).sort(
      (a, b) => a.position - b.position,
    );
    expect(returned.map((p) => p.id)).toEqual([p3, p1, p2]);
    expect(returned.map((p) => p.position)).toEqual([0, 1, 2]);

    // Persisted — a fresh GET reflects the new order.
    expect((await phasesForEpic(epicId)).map((p) => p.id)).toEqual([p3, p1, p2]);
  });

  it('400s when phaseIds is not an exact permutation of the epic phases', async () => {
    const epicId = await createEpic('Bad permutation epic');
    const p1 = await createPhase(epicId, 'A');
    await createPhase(epicId, 'B');

    await request
      .post(`/api/projects/${projectId}/board/phases/reorder`)
      .send({ epicId, phaseIds: [p1] }) // missing B
      .expect(400);

    await request
      .post(`/api/projects/${projectId}/board/phases/reorder`)
      .send({ epicId, phaseIds: [p1, p1] }) // duplicate
      .expect(400);
  });

  it('400s when neither phaseIds nor sortByDependencies is provided', async () => {
    const epicId = await createEpic('No-source epic');
    await createPhase(epicId, 'A');
    await request
      .post(`/api/projects/${projectId}/board/phases/reorder`)
      .send({ epicId })
      .expect(400);
  });
});

describe('POST /board/phases/reorder — auto sort by dependencies', () => {
  it('orders a foundation-last epic so blocker prerequisites come first', async () => {
    const epicId = await createEpic('Auto-sort epic');
    // Authored narrative order: front first, foundation last.
    const front = await createPhase(epicId, 'Front');
    const foundation = await createPhase(epicId, 'Foundation');
    expect((await phasesForEpic(epicId)).map((p) => p.id)).toEqual([front, foundation]);

    // A card in the front phase is blocked by a card in the foundation phase.
    const frontCard = (await createCard(projectId, {
      title: 'front work',
      epicId,
      phaseId: front,
    })) as { id: string };
    const foundationCard = (await createCard(projectId, {
      title: 'foundation work',
      epicId,
      phaseId: foundation,
    })) as { id: string };
    await request
      .post(`/api/projects/${projectId}/board/cards/${frontCard.id}/blockers`)
      .send({ blockedByCardId: foundationCard.id })
      .expect(201);

    const res = await request
      .post(`/api/projects/${projectId}/board/phases/reorder`)
      .send({ epicId, sortByDependencies: true })
      .expect(200);

    const ordered = (res.body as Array<{ id: string; position: number }>).sort(
      (a, b) => a.position - b.position,
    );
    // Foundation now precedes front.
    expect(ordered.map((p) => p.id)).toEqual([foundation, front]);
    expect((await phasesForEpic(epicId)).map((p) => p.id)).toEqual([foundation, front]);
  });
});
