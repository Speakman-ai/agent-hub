import './setup.js';
import { describe, expect, it, beforeAll, vi } from 'vitest';
import { getRequest, createProject, createAgent, createSession } from './helpers.js';
import type TestAgent from 'supertest/lib/agent.js';

let request: TestAgent;

beforeAll(async () => {
  request = await getRequest();
});

describe('session preview teardown', () => {
  it('stops the dev server for an explicit preview stop request', async () => {
    const project = await createProject({ id: 'stop-preview-project', cwd: '/tmp' });
    const agent = await createAgent({ projectId: project.id as string, id: 'stop-preview-agent' });
    const session = await createSession({ agentId: agent.id as string });
    const { routeDeps } = await import('../index.js');
    const stop = vi.fn().mockResolvedValue(1);
    routeDeps.getDevServerRuntime = () => ({ stopBySessionId: stop });

    await request.post(`/api/sessions/${session.id}/preview/stop`).expect(200);
    expect(stop).toHaveBeenCalledWith(session.id);
  });

  it('stops the dev server when a session is deleted', async () => {
    const project = await createProject({ id: 'delete-preview-project', cwd: '/tmp' });
    const agent = await createAgent({
      projectId: project.id as string,
      id: 'delete-preview-agent',
    });
    const session = await createSession({ agentId: agent.id as string });
    const { routeDeps } = await import('../index.js');
    const stop = vi.fn().mockResolvedValue(0);
    routeDeps.getDevServerRuntime = () => ({ stopBySessionId: stop });

    await request.delete(`/api/sessions/${session.id}`).expect(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(stop).toHaveBeenCalledWith(session.id);
  });
});
