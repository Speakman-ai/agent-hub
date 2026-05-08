import { beforeAll, describe, it, expect } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { getRequest, createProject, createAgent } from './helpers.js';
import type { CronRow } from '../types.js';

let request: TestAgent;

beforeAll(async () => {
  request = await getRequest();
});

describe('POST /api/crons skill_principal_agent_id', () => {
  it('accepts a principal that belongs to the cron project', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId, id: `pri-${Date.now()}` });
    const aid = agent.id as string;

    const res = await request
      .post('/api/crons')
      .send({
        name: `pri-ok-${Date.now()}`,
        schedule: '0 * * * *',
        prompt: 'noop',
        cwd: '/tmp',
        enabled: false,
        project_id: projectId,
        skill_principal_agent_id: aid,
      })
      .expect(200);

    const row = res.body as CronRow;
    expect(row.skill_principal_agent_id).toBe(aid);
  });

  it('rejects principal without project_id', async () => {
    const project = await createProject();
    const agent = await createAgent({ projectId: project.id as string });

    await request
      .post('/api/crons')
      .send({
        name: `pri-noproj-${Date.now()}`,
        schedule: '0 * * * *',
        prompt: 'noop',
        cwd: '/tmp',
        enabled: false,
        skill_principal_agent_id: agent.id,
      })
      .expect(400);
  });

  it('rejects principal that is not in the project roster', async () => {
    const p1 = await createProject();
    const p2 = await createProject();
    const foreign = await createAgent({ projectId: p2.id as string });

    await request
      .post('/api/crons')
      .send({
        name: `pri-foreign-${Date.now()}`,
        schedule: '0 * * * *',
        prompt: 'noop',
        cwd: '/tmp',
        enabled: false,
        project_id: p1.id as string,
        skill_principal_agent_id: foreign.id,
      })
      .expect(400);
  });
});
