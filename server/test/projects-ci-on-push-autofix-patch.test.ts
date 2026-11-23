import type supertest from 'supertest';
import { getRequest, createProject, createAgent } from './helpers.js';

// PATCH /api/projects/:projectId — ciOnPush.autoFix / ciOnPush.autoFixAgentId
// (start a fix session when the default branch goes red).

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

type Body = {
  ciOnPush?: { enabled?: boolean; autoFix?: boolean; autoFixAgentId?: string | null };
};

describe('PATCH /api/projects/:projectId — ciOnPush auto-fix', () => {
  it('merges autoFix and the agent into the existing ciOnPush setting', async () => {
    const projectId = (await createProject()).id as string;
    const agent = await createAgent({ projectId });
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ ciOnPush: { enabled: true } })
      .expect(200);
    let res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ ciOnPush: { autoFix: true } })
      .expect(200);
    expect((res.body as Body).ciOnPush).toEqual({ enabled: true, autoFix: true });

    res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ ciOnPush: { autoFixAgentId: agent.id } })
      .expect(200);
    expect((res.body as Body).ciOnPush).toEqual({
      enabled: true,
      autoFix: true,
      autoFixAgentId: agent.id,
    });

    res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ ciOnPush: { autoFixAgentId: '' } })
      .expect(200);
    expect((res.body as Body).ciOnPush?.autoFixAgentId).toBeNull();
  });

  it('rejects a non-boolean autoFix and an unknown agent', async () => {
    const projectId = (await createProject()).id as string;
    const bad = await request
      .patch(`/api/projects/${projectId}`)
      .send({ ciOnPush: { autoFix: 'yes' } })
      .expect(400);
    expect((bad.body as { error: string }).error).toMatch(/ciOnPush.autoFix must be a boolean/);
    const unknown = await request
      .patch(`/api/projects/${projectId}`)
      .send({ ciOnPush: { autoFixAgentId: 'nope' } })
      .expect(400);
    expect((unknown.body as { error: string }).error).toMatch(/agent on this project/);
  });
});
