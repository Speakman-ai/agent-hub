/**
 * Run-history routes — live app via supertest. Rows are seeded directly
 * through stmts (the push-CI engine has its own tests).
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';
import type { Stmts } from '../types.js';

let request: supertest.Agent;
let stmts: Stmts;

beforeAll(async () => {
  request = await getRequest();
  stmts = (await import('../db.js')).stmts!;
});

async function freshProject(): Promise<string> {
  const id = `ci-runs-test-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  return id;
}

function seedRun(
  projectId: string,
  overrides: { trigger?: string; status?: string; startedAt?: number } = {},
): string {
  const runId = uuidv4();
  stmts.insertFinalizeRun.run(
    runId,
    'ci-push',
    null,
    projectId,
    'main',
    uuidv4().replace(/-/g, '').padEnd(40, '0').slice(0, 40),
    `test|${runId}`,
    overrides.status ?? 'succeeded',
    null,
    overrides.trigger ?? 'git_push',
    null,
    'system',
    'Agent Hub CI',
    'ci@agent-hub.local',
    null,
    overrides.startedAt ?? Date.now(),
    'checks',
    null,
  );
  stmts.upsertFinalizeRunJob.run(runId, 'unit', 'default', 'success', 0, Date.now(), Date.now());
  stmts.upsertFinalizeRunStep.run(
    runId,
    1,
    'unit / default / test',
    'success',
    0,
    Date.now(),
    Date.now(),
    'unit',
    'default',
  );
  return runId;
}

describe('GET /api/projects/:projectId/ci-runs', () => {
  it('404s unknown projects', async () => {
    await request.get('/api/projects/nope/ci-runs').expect(404);
  });

  it('lists runs newest first with per-job rows', async () => {
    const projectId = await freshProject();
    seedRun(projectId, { trigger: 'git_push', startedAt: 1000 });
    const newest = seedRun(projectId, { trigger: 'ui_button', status: 'failed', startedAt: 2000 });

    const res = await request.get(`/api/projects/${projectId}/ci-runs`).expect(200);
    expect(res.body.runs).toHaveLength(2);
    expect(res.body.runs[0]).toMatchObject({
      id: newest,
      status: 'failed',
      trigger_source: 'ui_button',
      branch: 'main',
    });
    expect(res.body.runs[0].jobs[0]).toMatchObject({ job_id: 'unit', state: 'success' });
  });

  it('filters by trigger and caps limit', async () => {
    const projectId = await freshProject();
    seedRun(projectId, { trigger: 'git_push' });
    seedRun(projectId, { trigger: 'ui_button' });

    const pushOnly = await request
      .get(`/api/projects/${projectId}/ci-runs`)
      .query({ trigger: 'git_push' })
      .expect(200);
    expect(pushOnly.body.runs).toHaveLength(1);
    expect(pushOnly.body.runs[0].trigger_source).toBe('git_push');

    const limited = await request
      .get(`/api/projects/${projectId}/ci-runs`)
      .query({ limit: 1 })
      .expect(200);
    expect(limited.body.runs).toHaveLength(1);
  });

  it('run detail returns steps; 404 for cross-project run ids', async () => {
    const projectId = await freshProject();
    const otherProject = await freshProject();
    const runId = seedRun(projectId);

    const res = await request.get(`/api/projects/${projectId}/ci-runs/${runId}`).expect(200);
    expect(res.body.run.id).toBe(runId);
    expect(res.body.steps[0]).toMatchObject({ step_index: 1, state: 'success', job_id: 'unit' });

    await request.get(`/api/projects/${otherProject}/ci-runs/${runId}`).expect(404);
  });
});
