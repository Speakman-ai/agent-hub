import { createHmac } from 'crypto';
import { vi, describe, it, expect, beforeAll } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject, createAgent } from '../test/helpers.js';
import { stmts } from '../db.js';
import * as workflowRunner from '../workflow-runner.js';

vi.mock('../workflow-runner.js', () => ({
  startWorkflowRun: vi.fn(),
  requestWorkflowRunCancel: vi.fn(),
}));

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

  it('accepts stepProjectId so an agent from another project can run in that workspace', async () => {
    const home = await createProject();
    const other = await createProject();
    const homeId = home.id as string;
    const otherId = other.id as string;
    const agentOther = await createAgent({ projectId: otherId, name: 'Remote bot' });
    const agentOtherId = agentOther.id as string;

    const res = await request
      .post(`/api/projects/${homeId}/workflows`)
      .send({
        name: 'Cross-project pipeline',
        steps: [
          {
            agentId: agentOtherId,
            title: 'Act in other repo',
            rolePrompt: 'Use the other workspace context.',
            stepProjectId: otherId,
          },
        ],
      })
      .expect(201);
    expect(res.body.steps).toHaveLength(1);
    expect(res.body.steps[0].step_project_id).toBe(otherId);
    expect(res.body.steps[0].agent_id).toBe(agentOtherId);
  });

  it('rejects stepProjectId when the project does not exist', async () => {
    const home = await createProject();
    const homeId = home.id as string;
    const ag = await createAgent({ projectId: homeId });
    const res = await request.post(`/api/projects/${homeId}/workflows`).send({
      name: 'Bad ref',
      steps: [
        {
          agentId: ag.id,
          title: 'x',
          rolePrompt: 'y',
          stepProjectId: 'no-such-project-id-xyz',
        },
      ],
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/project not found/i);
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

  it('GET run detail and POST cancel for a pending run', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const { id: agentId } = (await createAgent({ projectId })) as { id: string };
    const c = await request
      .post(`/api/projects/${projectId}/workflows`)
      .send({ name: 'Detail', steps: [{ agentId, title: 's', rolePrompt: 'p' }] })
      .expect(201);
    const wfId = c.body.id as string;
    const runRes = await request
      .post(`/api/projects/${projectId}/workflows/${wfId}/runs`)
      .send({ payload: { k: 1 } })
      .expect(201);
    const runId = runRes.body.id as string;

    const detail = await request
      .get(`/api/projects/${projectId}/workflows/${wfId}/runs/${runId}`)
      .expect(200);
    expect(detail.body.run.id).toBe(runId);
    expect(detail.body.run.status).toBe('pending');
    expect(Array.isArray(detail.body.step_runs)).toBe(true);

    const cancel = await request
      .post(`/api/projects/${projectId}/workflows/${wfId}/runs/${runId}/cancel`)
      .expect(200);
    expect(cancel.body.ok).toBe(true);
    expect(cancel.body.cancelled).toBe(true);

    const after = await request
      .get(`/api/projects/${projectId}/workflows/${wfId}/runs/${runId}`)
      .expect(200);
    expect(after.body.run.status).toBe('cancelled');

    const again = await request
      .post(`/api/projects/${projectId}/workflows/${wfId}/runs/${runId}/cancel`)
      .expect(409);
    expect(String(again.body.error)).toMatch(/finished/i);
  });

  it('returns 404 for run detail when runId is unknown', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const { id: agentId } = (await createAgent({ projectId })) as { id: string };
    const c = await request
      .post(`/api/projects/${projectId}/workflows`)
      .send({ name: 'X', steps: [{ agentId, title: 's', rolePrompt: 'p' }] })
      .expect(201);
    const wfId = c.body.id as string;
    await request
      .get(`/api/projects/${projectId}/workflows/${wfId}/runs/00000000-0000-4000-8000-000000000099`)
      .expect(404);
  });

  it('POST cancel on a running run requests in-flight cancel', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const { id: agentId } = (await createAgent({ projectId })) as { id: string };
    const c = await request
      .post(`/api/projects/${projectId}/workflows`)
      .send({ name: 'Run', steps: [{ agentId, title: 's', rolePrompt: 'p' }] })
      .expect(201);
    const wfId = c.body.id as string;
    const runRes = await request
      .post(`/api/projects/${projectId}/workflows/${wfId}/runs`)
      .send({})
      .expect(201);
    const runId = runRes.body.id as string;
    stmts!.updateWorkflowRunToRunning.run(runId);

    const cancel = await request
      .post(`/api/projects/${projectId}/workflows/${wfId}/runs/${runId}/cancel`)
      .expect(200);
    expect(cancel.body.cancelRequested).toBe(true);
    expect(cancel.body.mode).toBe('running');
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

  it('rejects an invalid cron expression on create', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const { id: agentId } = (await createAgent({ projectId })) as { id: string };
    const res = await request.post(`/api/projects/${projectId}/workflows`).send({
      name: 'Bad cron',
      steps: [{ agentId, title: 'S', rolePrompt: 'P' }],
      cronExpr: 'not a cron',
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/cron/i);
  });

  it('stores schedule + webhook config and accepts a signed webhook POST', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const { id: agentId } = (await createAgent({ projectId })) as { id: string };
    const c = await request
      .post(`/api/projects/${projectId}/workflows`)
      .send({
        name: 'Hooked',
        steps: [{ agentId, title: 'S', rolePrompt: 'P' }],
        cronExpr: '0 * * * *',
        webhookEnabled: true,
      })
      .expect(201);
    expect(c.body.cron_valid).toBe(true);
    expect(c.body.cron_next_run_at).toBeTruthy();
    expect(c.body.cron_next_run_preview).toBeTruthy();
    expect(c.body.webhook_url).toMatch(/\/api\/workflow-webhook\//);
    expect(c.body.webhook_signing_secret).toBeTruthy();
    const url = c.body.webhook_url as string;
    const token = url.split('/api/workflow-webhook/')[1];
    const secret = c.body.webhook_signing_secret as string;
    const bodyStr = '{"source":"manual","ship":true}';
    const raw = Buffer.from(bodyStr, 'utf8');
    const sig = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    const wh = await request
      .post(`/api/workflow-webhook/${token}`)
      .set('X-Agent-Hub-Signature', sig)
      .set('Content-Type', 'application/json')
      .send(bodyStr);
    expect(wh.status).toBe(201);
    expect(wh.body.run_id).toBeTruthy();
    const runId = wh.body.run_id as string;
    const runRow = stmts!.getWorkflowRun.get(runId) as { run_payload: string | null };
    const parsed = JSON.parse(runRow.run_payload || '{}') as { source?: string; ship?: boolean };
    expect(parsed.source).toBe('webhook');
    expect(parsed.ship).toBe(true);
  });

  it('accepts triggerColumnId when the column belongs to the project kanban board', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const columns = board.body.columns as { id: string; name: string }[];
    const col = columns.find((c) => /done/i.test(c.name)) ?? columns[columns.length - 1];
    const { id: agentId } = (await createAgent({ projectId })) as { id: string };

    const c = await request
      .post(`/api/projects/${projectId}/workflows`)
      .send({
        name: 'On column',
        triggerColumnId: col.id,
        steps: [{ agentId, title: 'S', rolePrompt: 'R' }],
      })
      .expect(201);
    expect(c.body.trigger_column_id).toBe(col.id);
  });

  it('rejects triggerColumnId when the column is not on the project board', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const { id: agentId } = (await createAgent({ projectId })) as { id: string };
    const res = await request.post(`/api/projects/${projectId}/workflows`).send({
      name: 'Bad col',
      triggerColumnId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      steps: [{ agentId, title: 'S', rolePrompt: 'R' }],
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/column/i);
  });

  it('starts a workflow run when a card moves into the configured trigger column', async () => {
    const startMock = vi.mocked(workflowRunner.startWorkflowRun);
    startMock.mockClear();

    const project = await createProject();
    const projectId = project.id as string;
    const { id: agentId } = (await createAgent({ projectId })) as { id: string };
    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const columns = board.body.columns as { id: string; name: string }[];
    const target = columns.find((c) => c.name === 'Done') ?? columns[columns.length - 1];
    const from = columns.find((c) => c.name === 'Backlog') ?? columns[0];

    await request
      .post(`/api/projects/${projectId}/workflows`)
      .send({
        name: 'Enter Done',
        triggerColumnId: target.id,
        steps: [{ agentId, title: 'Wrap', rolePrompt: 'Finish for card' }],
      })
      .expect(201);

    const cardTitle = `Ship it ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const card = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({
        title: cardTitle,
        columnId: from.id,
        priority: 'medium',
      })
      .expect(200);

    await request
      .post(`/api/projects/${projectId}/board/cards/${card.body.id as string}/move`)
      .send({ columnId: target.id })
      .expect(200);

    expect(startMock).toHaveBeenCalled();
    const wfList = await request.get(`/api/projects/${projectId}/workflows`).expect(200);
    const wfId = (wfList.body as { id: string; name: string }[]).find(
      (w) => w.name === 'Enter Done',
    )?.id as string;
    const runs = stmts!.getWorkflowRunsLimited.all(wfId, 5) as { run_payload: string | null }[];
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(runs[0].run_payload || '{}') as {
      source?: string;
      columnId?: string;
      card?: { title?: string };
    };
    expect(parsed.source).toBe('kanban_column');
    expect(parsed.columnId).toBe(target.id);
    expect(parsed.card?.title).toBe(cardTitle);
  });
});
