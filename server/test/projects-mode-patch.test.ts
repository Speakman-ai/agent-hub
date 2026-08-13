import type supertest from 'supertest';
import { getRequest, createProject, createAgent, createSession } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('PATCH /api/projects/:projectId — mode with live sessions', () => {
  it('rejects dev→workflow while a live session exists (409)', async () => {
    const project = await createProject({ mode: 'dev' });
    const projectId = project.id as string;
    const agent = await createAgent({ projectId });
    await createSession({ agentId: agent.id as string });

    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ mode: 'workflow' })
      .expect(409);
    expect((res.body as { code?: string }).code).toBe('mode_change_blocked_by_sessions');
    expect((res.body as { liveSessionCount?: number }).liveSessionCount).toBeGreaterThanOrEqual(1);

    const still = await request.get(`/api/projects/${projectId}`).expect(200);
    expect((still.body as { mode?: string }).mode).toBe('dev');
  });

  it('rejects workflow→dev while a live session exists (409)', async () => {
    const project = await createProject({ mode: 'workflow' });
    const projectId = project.id as string;
    const agent = await createAgent({ projectId });
    await createSession({ agentId: agent.id as string });

    const res = await request.patch(`/api/projects/${projectId}`).send({ mode: 'dev' }).expect(409);
    expect((res.body as { code?: string }).code).toBe('mode_change_blocked_by_sessions');

    const still = await request.get(`/api/projects/${projectId}`).expect(200);
    expect((still.body as { mode?: string }).mode).toBe('workflow');
  });

  it('allows mode change when no live sessions remain', async () => {
    const project = await createProject({ mode: 'dev' });
    const projectId = project.id as string;
    const agent = await createAgent({ projectId });
    const session = await createSession({ agentId: agent.id as string });
    const sessionId = (session as { id: string }).id;

    await request.delete(`/api/sessions/${sessionId}`).expect(200);

    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ mode: 'workflow' })
      .expect(200);
    expect((res.body as { mode?: string }).mode).toBe('workflow');
  });

  it('allows a no-op mode patch that does not change effective mode', async () => {
    const project = await createProject({ mode: 'workflow' });
    const projectId = project.id as string;
    const agent = await createAgent({ projectId });
    await createSession({ agentId: agent.id as string });

    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ mode: 'workflow' })
      .expect(200);
    expect((res.body as { mode?: string }).mode).toBe('workflow');
  });

  it('leaves cwd untouched when a mixed mode patch is rejected', async () => {
    const project = await createProject({ mode: 'workflow' });
    const projectId = project.id as string;
    const originalCwd = (project as { cwd: string }).cwd;
    expect(originalCwd).toBeTruthy();
    const agent = await createAgent({ projectId });
    await createSession({ agentId: agent.id as string });

    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ cwd: '/tmp/should-not-stick', mode: 'dev' })
      .expect(409);
    expect((res.body as { code?: string }).code).toBe('mode_change_blocked_by_sessions');

    const still = await request.get(`/api/projects/${projectId}`).expect(200);
    expect((still.body as { mode?: string }).mode).toBe('workflow');
    expect((still.body as { cwd?: string }).cwd).toBe(originalCwd);
  });
});
