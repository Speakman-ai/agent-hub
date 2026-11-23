import { describe, it, expect, beforeAll } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject, createCard } from './helpers.js';

// A phased card blocked by a card its phase order can never reach (a later
// phase of the same epic, or another epic) stalls the phase silently. The
// blocker endpoint still creates the edge but returns a `warning`.

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

async function addBlocker(cardId: string, blockedByCardId: string) {
  return request
    .post(`/api/projects/${projectId}/board/cards/${cardId}/blockers`)
    .send({ blockedByCardId })
    .expect(201);
}

async function doneColumnId(): Promise<string> {
  const res = await request.get(`/api/projects/${projectId}/board`).expect(200);
  const cols = (res.body as { columns: Array<{ id: string; name: string }> }).columns;
  const done = cols.find((c) => c.name === 'Done');
  if (!done) throw new Error('No Done column');
  return done.id;
}

beforeAll(async () => {
  request = await getRequest();
  projectId = (await createProject()).id as string;
});

describe('POST /board/cards/:cardId/blockers placement warning', () => {
  it('warns when a Phase 1 card is blocked by a Phase 2 card of the same epic', async () => {
    const epicId = await createEpic('Later-phase epic');
    const p1 = await createPhase(epicId, 'Phase 1');
    const p2 = await createPhase(epicId, 'Phase 2');
    const early = (await createCard(projectId, { title: 'early', epicId, phaseId: p1 })) as {
      id: string;
    };
    const late = (await createCard(projectId, { title: 'late', epicId, phaseId: p2 })) as {
      id: string;
    };

    const res = await addBlocker(early.id, late.id);
    expect(res.body.warning.kind).toBe('later_phase');
    expect(res.body.warning.message).toContain('Phase 2');
  });

  it('warns when a phased card is blocked by a card in another epic', async () => {
    const epicA = await createEpic('Provisioning');
    const epicB = await createEpic('Onboarding');
    const a1 = await createPhase(epicA, 'Phase 1');
    const b1 = await createPhase(epicB, 'P1');
    await createPhase(epicB, 'P2');
    const stepper = (await createCard(projectId, {
      title: 'Stepper training step',
      epicId: epicA,
      phaseId: a1,
    })) as { id: string };
    const enroll = (await createCard(projectId, {
      title: 'Auto-enroll training',
      epicId: epicB,
      phaseId: b1,
    })) as { id: string };

    const res = await addBlocker(stepper.id, enroll.id);
    expect(res.body.warning.kind).toBe('other_epic');
    expect(res.body.warning.message).toContain('Onboarding');
  });

  it('has no warning when the blocker is in an earlier phase', async () => {
    const epicId = await createEpic('Ordered epic');
    const p1 = await createPhase(epicId, 'Phase 1');
    const p2 = await createPhase(epicId, 'Phase 2');
    const first = (await createCard(projectId, { title: 'first', epicId, phaseId: p1 })) as {
      id: string;
    };
    const second = (await createCard(projectId, { title: 'second', epicId, phaseId: p2 })) as {
      id: string;
    };

    const res = await addBlocker(second.id, first.id);
    expect(res.body.warning).toBeUndefined();
  });

  it('has no warning when a completed blocker sits in a later phase', async () => {
    const epicId = await createEpic('Done later-phase epic');
    const p1 = await createPhase(epicId, 'Phase 1');
    const p2 = await createPhase(epicId, 'Phase 2');
    const early = (await createCard(projectId, { title: 'early', epicId, phaseId: p1 })) as {
      id: string;
    };
    const late = (await createCard(projectId, {
      title: 'late, shipped',
      epicId,
      phaseId: p2,
      columnId: await doneColumnId(),
    })) as { id: string };

    const res = await addBlocker(early.id, late.id);
    expect(res.body.warning).toBeUndefined();
  });

  it('has no warning when a completed blocker lives in another epic', async () => {
    const epicA = await createEpic('Done cross-epic A');
    const epicB = await createEpic('Done cross-epic B');
    const a1 = await createPhase(epicA, 'Phase 1');
    const b1 = await createPhase(epicB, 'Phase 1');
    const waiting = (await createCard(projectId, {
      title: 'waiting',
      epicId: epicA,
      phaseId: a1,
    })) as {
      id: string;
    };
    const shipped = (await createCard(projectId, {
      title: 'shipped elsewhere',
      epicId: epicB,
      phaseId: b1,
      columnId: await doneColumnId(),
    })) as { id: string };

    const res = await addBlocker(waiting.id, shipped.id);
    expect(res.body.warning).toBeUndefined();
  });
});
