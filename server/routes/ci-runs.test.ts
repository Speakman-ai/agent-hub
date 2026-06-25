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

function seedSession(name: string): string {
  const sessionId = uuidv4();
  stmts.createSession.run(sessionId, 'some-agent', name, 'claude', 'sonnet', 1, 0, 1);
  return sessionId;
}

function seedRun(
  projectId: string,
  overrides: { trigger?: string; status?: string; startedAt?: number; sessionId?: string } = {},
): string {
  const runId = uuidv4();
  stmts.insertFinalizeRun.run(
    runId,
    'ci-push',
    overrides.sessionId ?? null,
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

  it('batch-resolves linked session titles across runs (and null when no session)', async () => {
    const projectId = await freshProject();
    // Two DISTINCT sessions plus a sessionless push run: the list endpoint
    // must map each run to its own title via a single batched lookup, not an
    // N+1 per-row query.
    const sessionA = seedSession('Fix login redirect');
    const sessionB = seedSession('Add CSV export');
    seedRun(projectId, { trigger: 'agent_block', startedAt: 1000, sessionId: sessionA });
    seedRun(projectId, { trigger: 'agent_block', startedAt: 2000, sessionId: sessionB });
    seedRun(projectId, { trigger: 'git_push', startedAt: 3000 });

    const res = await request.get(`/api/projects/${projectId}/ci-runs`).expect(200);
    // Newest first: push (no session), then sessionB, then sessionA.
    expect(res.body.runs[0]).toMatchObject({ session_id: null, session_title: null });
    expect(res.body.runs[1]).toMatchObject({
      session_id: sessionB,
      session_title: 'Add CSV export',
    });
    expect(res.body.runs[2]).toMatchObject({
      session_id: sessionA,
      session_title: 'Fix login redirect',
    });
  });

  it('run detail also surfaces the linked session title', async () => {
    const projectId = await freshProject();
    const sessionId = seedSession('Refactor auth');
    const runId = seedRun(projectId, { trigger: 'agent_block', sessionId });

    const res = await request.get(`/api/projects/${projectId}/ci-runs/${runId}`).expect(200);
    expect(res.body.run).toMatchObject({ session_id: sessionId, session_title: 'Refactor auth' });
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
