import { describe, it, expect, beforeAll } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject, createCard } from './helpers.js';

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
});

async function createEpic(name: string): Promise<string> {
  const res = await request
    .post(`/api/projects/${projectId}/board/epics`)
    .send({ name, description: '', color: '#6366F1' })
    .expect(200);
  return (res.body as { id: string }).id;
}

// Enable autonomous while the epic is still EMPTY so the immediate dispatch
// tick has nothing to pick up (no agents exist in the test project anyway).
async function enableAutonomous(id: string, name: string): Promise<void> {
  await request
    .put(`/api/projects/${projectId}/board/epics/${id}`)
    .send({ name, autonomous: 1, autonomousInterval: 5, autonomousMaxConcurrent: 1 })
    .expect(200);
}

async function epicAutonomousFlag(id: string): Promise<number | undefined> {
  const board = (await request.get(`/api/projects/${projectId}/board`).expect(200)).body as {
    epics: Array<{ id: string; autonomous?: number }>;
  };
  return board.epics.find((e) => e.id === id)?.autonomous;
}

describe('Autonomous epic disarms when it runs out of cards', () => {
  it('deleting the last card of an autonomous epic disables autonomous', async () => {
    const epicId = await createEpic('Empty-on-delete');
    await enableAutonomous(epicId, 'Empty-on-delete');
    const card = await createCard(projectId, { title: 'only card', epicId });
    expect(await epicAutonomousFlag(epicId)).toBe(1);

    await request.delete(`/api/projects/${projectId}/board/cards/${card.id as string}`).expect(200);

    expect(await epicAutonomousFlag(epicId)).toBe(0);
  });

  it('deleting one card while others remain keeps autonomous on', async () => {
    const epicId = await createEpic('Still-has-cards');
    await enableAutonomous(epicId, 'Still-has-cards');
    const cardA = await createCard(projectId, { title: 'card A', epicId });
    await createCard(projectId, { title: 'card B', epicId });
    expect(await epicAutonomousFlag(epicId)).toBe(1);

    await request
      .delete(`/api/projects/${projectId}/board/cards/${cardA.id as string}`)
      .expect(200);

    expect(await epicAutonomousFlag(epicId)).toBe(1);

    // Tidy up: disarm so no live cron lingers for the rest of the suite.
    await request
      .put(`/api/projects/${projectId}/board/epics/${epicId}`)
      .send({ name: 'Still-has-cards', autonomous: 0 })
      .expect(200);
  });

  it('unlinking the last card of an autonomous epic disables autonomous', async () => {
    const epicId = await createEpic('Empty-on-unlink');
    await enableAutonomous(epicId, 'Empty-on-unlink');
    const card = await createCard(projectId, { title: 'lone card', epicId });
    expect(await epicAutonomousFlag(epicId)).toBe(1);

    // Detach the card from the epic (epicId: null).
    await request
      .post(`/api/projects/${projectId}/board/cards/${card.id as string}/epic`)
      .send({ epicId: null })
      .expect(200);

    expect(await epicAutonomousFlag(epicId)).toBe(0);
  });

  it('reassigning the last card to another epic disarms the source epic', async () => {
    const sourceEpic = await createEpic('Source-epic');
    const targetEpic = await createEpic('Target-epic');
    await enableAutonomous(sourceEpic, 'Source-epic');
    const card = await createCard(projectId, { title: 'moving card', epicId: sourceEpic });
    expect(await epicAutonomousFlag(sourceEpic)).toBe(1);

    await request
      .post(`/api/projects/${projectId}/board/cards/${card.id as string}/epic`)
      .send({ epicId: targetEpic })
      .expect(200);

    expect(await epicAutonomousFlag(sourceEpic)).toBe(0);
    // Target epic was never autonomous — moving a card in must not arm it.
    expect(await epicAutonomousFlag(targetEpic)).toBeFalsy();
  });
});
