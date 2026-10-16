import type supertest from 'supertest';
import { getRequest, createProject, createAgent } from './helpers.js';

// PATCH /api/projects/:projectId — autoResolvePr (auto-resolve failing PRs).
// An object with optional boolean `enabled` and optional `agentId` that must
// name an agent on the project; `null` clears it.

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

type Body = { autoResolvePr?: { enabled?: boolean; agentId?: string | null } };

describe('PATCH /api/projects/:projectId — autoResolvePr', () => {
  it('persists enabled and merges later partial updates', async () => {
    const projectId = (await createProject()).id as string;
    const agent = await createAgent({ projectId });
    let res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ autoResolvePr: { enabled: true } })
      .expect(200);
    expect((res.body as Body).autoResolvePr).toEqual({ enabled: true });

    res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ autoResolvePr: { agentId: agent.id } })
      .expect(200);
    expect((res.body as Body).autoResolvePr).toEqual({ enabled: true, agentId: agent.id });

    res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ autoResolvePr: { agentId: '' } })
      .expect(200);
    expect((res.body as Body).autoResolvePr).toEqual({ enabled: true, agentId: null });
  });

  it('clears the setting when null is sent', async () => {
    const projectId = (await createProject()).id as string;
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ autoResolvePr: { enabled: true } })
      .expect(200);
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ autoResolvePr: null })
      .expect(200);
    expect((res.body as Body).autoResolvePr).toBeUndefined();
  });

  it('rejects a non-object, a non-boolean enabled, and an unknown agent', async () => {
    const projectId = (await createProject()).id as string;
    await request.patch(`/api/projects/${projectId}`).send({ autoResolvePr: true }).expect(400);
    const bad = await request
      .patch(`/api/projects/${projectId}`)
      .send({ autoResolvePr: { enabled: 'yes' } })
      .expect(400);
    expect((bad.body as { error: string }).error).toMatch(
      /autoResolvePr.enabled must be a boolean/,
    );
    const unknown = await request
      .patch(`/api/projects/${projectId}`)
      .send({ autoResolvePr: { agentId: 'nope' } })
      .expect(400);
    expect((unknown.body as { error: string }).error).toMatch(/agent on this project/);
  });
});
