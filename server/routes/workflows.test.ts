import { describe, it, expect, beforeAll } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject, createAgent } from '../test/helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

describe('Workflows API', () => {
  it('lists and creates a workflow with steps, then runs', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId, name: 'Wf Agent' });
    const agentId = agent.id as string;

    const empty = await request.get(`/api/projects/${projectId}/workflows`).expect(200);
    expect(empty.body).toEqual([]);

    const createRes = await request
      .post(`/api/projects/${projectId}/workflows`)
      .send({
        name: 'Ship feature',
        defaultPayload: { branch: 'main' },
        steps: [
          {
            agentId,
            title: 'Implement',
            rolePrompt: 'Do the work',
            stepOrder: 0,
            onFailure: 'abort',
          },
        ],
      })
      .expect(201);
    expect(createRes.body.name).toBe('Ship feature');
    expect(createRes.body.default_payload).toEqual({ branch: 'main' });
    expect(createRes.body.steps).toHaveLength(1);
    expect(createRes.body.steps[0].agent_id).toBe(agentId);
    const wfId = createRes.body.id as string;

    const list = await request.get(`/api/projects/${projectId}/workflows`).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(wfId);

    const getOne = await request.get(`/api/projects/${projectId}/workflows/${wfId}`).expect(200);
    expect(getOne.body.id).toBe(wfId);
    expect(getOne.body.steps[0].title).toBe('Implement');

    const run = await request
      .post(`/api/projects/${projectId}/workflows/${wfId}/runs`)
      .send({ payload: { ticket: 'HUB-1' } })
      .expect(201);
    expect(run.body.status).toBe('pending');
    expect(run.body.run_payload).toEqual({ ticket: 'HUB-1' });

    const runs = await request.get(`/api/projects/${projectId}/workflows/${wfId}/runs`).expect(200);
    expect(runs.body).toHaveLength(1);
    expect(runs.body[0].id).toBe(run.body.id);

    await request
      .post(`/api/projects/${projectId}/workflows/${wfId}/runs`)
      .send({ payload: { ticket: 'HUB-2' } })
      .expect(201);
    const twoRuns = await request
      .get(`/api/projects/${projectId}/workflows/${wfId}/runs?limit=1`)
      .expect(200);
    expect(twoRuns.body).toHaveLength(1);
  });

  it('rejects a step when the agent is not in the project', async () => {
    const a = await createAgent();
    const b = await createAgent();
    const projectA = a.projectId as string;
    const otherAgentId = b.id as string;

    const res = await request.post(`/api/projects/${projectA}/workflows`).send({
      name: 'Bad',
      steps: [
        {
          agentId: otherAgentId,
          title: 'x',
          rolePrompt: 'y',
        },
      ],
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/agent not found|project/i);
  });

  it('replaces steps on put and deletes workflow', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const ag = await createAgent({ projectId });
    const agentId = ag.id as string;

    const c = await request
      .post(`/api/projects/${projectId}/workflows`)
      .send({
        name: 'E2E',
        steps: [
          {
            agentId,
            title: 'One',
            rolePrompt: 'R1',
          },
        ],
      })
      .expect(201);
    const wfId = c.body.id as string;

    await request
      .put(`/api/projects/${projectId}/workflows/${wfId}`)
      .send({
        name: 'E2E v2',
        steps: [
          { agentId, title: 'Two', rolePrompt: 'R2', stepOrder: 0 },
          { agentId, title: 'Three', rolePrompt: 'R3', stepOrder: 1 },
        ],
      })
      .expect(200);

    const g = await request.get(`/api/projects/${projectId}/workflows/${wfId}`).expect(200);
    expect(g.body.name).toBe('E2E v2');
    expect(g.body.steps).toHaveLength(2);
    expect(g.body.steps[0].title).toBe('Two');

    await request.delete(`/api/projects/${projectId}/workflows/${wfId}`).expect(200);
    await request.get(`/api/projects/${projectId}/workflows/${wfId}`).expect(404);
  });

  it('batches step rows when listing many workflows (no N+1)', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const ag = await createAgent({ projectId });
    const agentId = ag.id as string;

    await request
      .post(`/api/projects/${projectId}/workflows`)
      .send({ name: 'A', steps: [{ agentId, title: 's1', rolePrompt: 'p' }] })
      .expect(201);
    await request
      .post(`/api/projects/${projectId}/workflows`)
      .send({ name: 'B', steps: [{ agentId, title: 's2', rolePrompt: 'p' }] })
      .expect(201);
    const list = await request.get(`/api/projects/${projectId}/workflows`).expect(200);
    expect(list.body).toHaveLength(2);
    const names = new Set((list.body as { name: string }[]).map((w) => w.name));
    expect(names).toEqual(new Set(['A', 'B']));
    for (const w of list.body as { steps: { title: string }[] }[]) {
      expect(w.steps).toHaveLength(1);
    }
  });

  it('rejects duplicate step id in a single create', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const { id: agentId } = (await createAgent({ projectId })) as { id: string };
    const dup = '00000000-0000-4000-8000-0000000000aa';
    const res = await request.post(`/api/projects/${projectId}/workflows`).send({
      name: 'Dups',
      steps: [
        { id: dup, agentId, title: 'A', rolePrompt: 'R' },
        { id: dup, agentId, title: 'B', rolePrompt: 'R' },
      ],
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/duplicate step/i);
  });

  it('returns 400 for SQLite UNIQUE on workflow step id (collision)', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const { id: agentId } = (await createAgent({ projectId })) as { id: string };
    const fixed = '00000000-0000-4000-8000-0000000000bb';
    await request
      .post(`/api/projects/${projectId}/workflows`)
      .send({
        name: 'W1',
        steps: [{ id: fixed, agentId, title: 'S', rolePrompt: 'P' }],
      })
      .expect(201);
    const res = await request.post(`/api/projects/${projectId}/workflows`).send({
      name: 'W2',
      steps: [{ id: fixed, agentId, title: 'T', rolePrompt: 'P' }],
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/duplicate|conflicting|unique|step `id`/i);
  });

  it('stores null run payload when payload is null, and fallbacks for bad ?limit', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const { id: agentId } = (await createAgent({ projectId })) as { id: string };
    const c = await request
      .post(`/api/projects/${projectId}/workflows`)
      .send({ name: 'Runs', steps: [{ agentId, title: 's', rolePrompt: 'p' }] })
      .expect(201);
    const wfId = c.body.id as string;
    const nullRun = await request
      .post(`/api/projects/${projectId}/workflows/${wfId}/runs`)
      .send({ payload: null })
      .expect(201);
    expect(nullRun.body.run_payload).toBeNull();
    const empty = await request
      .post(`/api/projects/${projectId}/workflows/${wfId}/runs`)
      .send({})
      .expect(201);
    expect(empty.body.run_payload).toBeNull();

    await request
      .post(`/api/projects/${projectId}/workflows/${wfId}/runs`)
      .send({ payload: { a: 1 } })
      .expect(201);
    const withZero = await request
      .get(`/api/projects/${projectId}/workflows/${wfId}/runs?limit=0`)
      .expect(200);
    expect(withZero.body.length).toBe(3);
    const withBad = await request
      .get(`/api/projects/${projectId}/workflows/${wfId}/runs?limit=notnum`)
      .expect(200);
    expect(withBad.body.length).toBe(3);
  });

  it('returns 404 for another projects workflow id', async () => {
    const p1 = await createProject();
    const p2 = await createProject();
    const a1 = await createAgent({ projectId: p1.id as string });
    const agentId = a1.id as string;
    const c = await request
      .post(`/api/projects/${p1.id as string}/workflows`)
      .send({ name: 'Solo', steps: [{ agentId, title: 'S', rolePrompt: 'P' }] })
      .expect(201);
    const wid = c.body.id as string;
    await request.get(`/api/projects/${p2.id as string}/workflows/${wid}`).expect(404);
  });
});
