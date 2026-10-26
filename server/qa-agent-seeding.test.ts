import type supertest from 'supertest';
import { getRequest } from './test/helpers.js';
import config from './config.js';
import { ensureQaAgents, findProject, saveProjects } from './project-model.js';
import { qaAgentId } from './qa-agent-prompt.js';
import { getStmts } from './db.js';
import type { SessionRow } from './types.js';

let request: supertest.Agent;
let originalApiKey: string | null;
const createdProjectIds: string[] = [];
let seq = 0;

function uniqueId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

async function onboardProject(projId: string): Promise<void> {
  const res = await request.post('/api/projects/onboard').send({
    project: { id: projId, name: 'QA Seed', cwd: '/tmp' },
    agents: [
      {
        id: `${projId}-dev`,
        name: 'Dev',
        role: 'dev',
        engine: 'claude-code',
        systemPrompt: 'You are the dev agent.',
      },
    ],
  });
  expect(res.status).toBe(201);
  createdProjectIds.push(projId);
}

beforeAll(async () => {
  request = await getRequest();
  originalApiKey = config.apiKey;
  config.apiKey = null;
}, 60_000);

afterAll(async () => {
  for (const id of createdProjectIds) {
    await request.delete(`/api/projects/${id}`).catch(() => {});
  }
  config.apiKey = originalApiKey;
});

describe('QA agent seeding at project creation', () => {
  it('onboard seeds one QA agent with a QA system prompt', async () => {
    const projId = uniqueId('qa-onboard');
    await onboardProject(projId);

    const qa = findProject(projId)!.agents.filter((a) => a.role === 'qa');
    expect(qa).toHaveLength(1);
    expect(qa[0].id).toBe(qaAgentId(projId));
    expect(qa[0].isDev).toBe(false);
    expect(qa[0].systemPrompt).toMatch(/QA agent/);
    expect(qa[0].systemPrompt).toMatch(/read-only on code/);
  });

  it('workflow project creation seeds a QA agent', async () => {
    const projId = uniqueId('qa-workflow');
    const res = await request
      .post('/api/projects')
      .send({ id: projId, name: 'QA Workflow', mode: 'workflow' });
    expect(res.status).toBe(201);
    createdProjectIds.push(projId);

    const roles = findProject(projId)!.agents.map((a) => a.role);
    expect(roles.filter((r) => r === 'qa')).toHaveLength(1);
  });
});

describe('ensureQaAgents', () => {
  it('is idempotent and does not add a second QA agent', async () => {
    const projId = uniqueId('qa-idem');
    await onboardProject(projId);

    expect(ensureQaAgents(projId)).toBe(false);
    expect(ensureQaAgents()).toBe(false);
    expect(findProject(projId)!.agents.filter((a) => a.role === 'qa')).toHaveLength(1);
  });

  it('with a projectId only seeds that project', async () => {
    const a = uniqueId('qa-scope-a');
    const b = uniqueId('qa-scope-b');
    await onboardProject(a);
    await onboardProject(b);
    for (const id of [a, b]) {
      const p = findProject(id)!;
      p.agents = p.agents.filter((ag) => ag.role !== 'qa');
    }
    saveProjects();

    expect(ensureQaAgents(a)).toBe(true);
    expect(findProject(a)!.agents.some((ag) => ag.role === 'qa')).toBe(true);
    expect(findProject(b)!.agents.some((ag) => ag.role === 'qa')).toBe(false);
  });

  it('skips projects with no agents', async () => {
    const projId = uniqueId('qa-empty');
    const res = await request
      .post('/api/projects')
      .send({ id: projId, name: 'Empty', cwd: '/tmp' });
    expect(res.status).toBe(201);
    createdProjectIds.push(projId);

    ensureQaAgents(projId);
    expect(findProject(projId)!.agents).toHaveLength(0);
  });
});

describe('QA agent sessions', () => {
  it('a new QA agent session runs in qa mode with no worktree', async () => {
    const projId = uniqueId('qa-session');
    await onboardProject(projId);

    const res = await request.post(`/api/agents/${qaAgentId(projId)}/sessions`).send({});
    expect(res.status).toBe(200);
    const row = getStmts().getSession.get(res.body.id) as SessionRow;
    expect(row.session_mode).toBe('qa');
    expect(Number(row.use_worktree)).toBe(0);
  });

  it('refuses to switch a QA session into a shipping mode', async () => {
    const projId = uniqueId('qa-switch');
    await onboardProject(projId);
    const created = await request.post(`/api/agents/${qaAgentId(projId)}/sessions`).send({});
    expect(created.status).toBe(200);

    const put = await request.put(`/api/sessions/${created.body.id}/mode`).send({ mode: 'chat' });
    expect(put.status).toBe(400);
    expect(put.body.error).toBe('qa_agent_requires_qa_mode');

    const patch = await request
      .patch(`/api/sessions/${created.body.id}`)
      .send({ session_mode: 'chat' });
    expect(patch.status).toBe(400);
    expect(patch.body.error).toBe('qa_agent_requires_qa_mode');
  });

  it('refuses qa mode on a dev agent session', async () => {
    const projId = uniqueId('qa-devmode');
    await onboardProject(projId);

    const create = await request
      .post(`/api/agents/${projId}-dev/sessions`)
      .send({ session_mode: 'qa' });
    expect(create.status).toBe(400);
    expect(create.body.error).toBe('qa_mode_requires_qa_agent');
  });
});
