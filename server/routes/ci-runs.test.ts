/**
 * Run-history routes — live app via supertest. Rows are seeded directly
 * through stmts (the push-CI engine has its own tests).
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getRequest } from '../test/helpers.js';
import { getDb } from '../db.js';
import type { Stmts } from '../types.js';

let request: supertest.Agent;
let stmts: Stmts;

beforeAll(async () => {
  request = await getRequest();
  stmts = (await import('../db.js')).stmts!;
});

async function freshProject(cwd = '/tmp'): Promise<string> {
  const id = `ci-runs-test-${uuidv4().slice(0, 8)}`;
  await request.post('/api/projects').send({ id, name: id, cwd, color: '#3B82F6' }).expect(201);
  return id;
}

function seedSession(name: string): string {
  const sessionId = uuidv4();
  stmts.createSession.run(sessionId, 'some-agent', name, 'claude', 'sonnet', 1, 0, 1);
  return sessionId;
}

function seedRun(
  projectId: string,
  overrides: {
    trigger?: string;
    status?: string;
    startedAt?: number;
    endedAt?: number;
    sessionId?: string;
    failureReason?: string | null;
  } = {},
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
  if (typeof overrides.endedAt === 'number' || overrides.failureReason !== undefined) {
    getDb()
      .prepare('UPDATE finalize_runs SET ended_at = ?, failure_reason = ? WHERE id = ?')
      .run(overrides.endedAt ?? null, overrides.failureReason ?? null, runId);
  }
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

function freshRepoWithCiYaml(content: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-hub-ci-runs-'));
  mkdirSync(path.join(root, '.agent-hub'), { recursive: true });
  writeFileSync(path.join(root, '.agent-hub', 'ci.yaml'), content, 'utf8');
  return root;
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

  it('summarizes overall and per-ci.yaml test stats', async () => {
    const cwd = freshRepoWithCiYaml(`
version: 2
on: [finalize]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: npm run build
  test:
    runs-on: ubuntu-24.04
    matrix:
      include:
        - group: server
        - group: client
    steps:
      - run: npm test
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: npm run lint
`);
    const projectId = await freshProject(cwd);
    const runA = seedRun(projectId, { status: 'succeeded', startedAt: 1_000, endedAt: 61_000 });
    const runB = seedRun(projectId, {
      status: 'failed',
      startedAt: 101_000,
      endedAt: 161_000,
      failureReason: 'step_failed',
    });
    const runC = seedRun(projectId, {
      status: 'infra_error',
      startedAt: 201_000,
      endedAt: 261_000,
      failureReason: 'container_unavailable',
    });

    // Replace the default seed helper's unit job with ci.yaml-shaped jobs.
    getDb()
      .prepare('DELETE FROM finalize_run_jobs WHERE run_id IN (?, ?, ?)')
      .run(runA, runB, runC);
    stmts.upsertFinalizeRunJob.run(runA, 'build', '', 'passed', 0, 2_000, 12_000);
    stmts.upsertFinalizeRunJob.run(runA, 'test', 'server', 'passed', 0, 2_000, 32_000);
    stmts.upsertFinalizeRunJob.run(runA, 'test', 'client', 'passed', 0, 2_000, 42_000);
    stmts.upsertFinalizeRunJob.run(runB, 'build', '', 'passed', 0, 102_000, 112_000);
    stmts.upsertFinalizeRunJob.run(runB, 'test', 'server', 'failed', 1, 102_000, 142_000);
    stmts.upsertFinalizeRunJob.run(runB, 'test', 'client', 'passed', 0, 102_000, 132_000);
    stmts.upsertFinalizeRunJob.run(runC, 'test', 'client', 'failed', -1, 202_000, 252_000);

    const res = await request.get(`/api/projects/${projectId}/ci-runs/stats`).expect(200);
    expect(res.body.overall).toMatchObject({
      average_seconds: 60,
      total_runs: 3,
      failed_runs: 2,
      total_errors: 2,
      infra_errors: 1,
    });
    expect(res.body.overall.failure_rate).toBeCloseTo(2 / 3);
    expect(res.body.overall.infra_error_rate).toBeCloseTo(1 / 2);

    const byName = new Map<string, Record<string, unknown>>(
      res.body.tests.map((t: Record<string, unknown>) => [String(t.name), t]),
    );
    expect(byName.get('build')).toMatchObject({
      configured: true,
      average_seconds: 10,
      total_runs: 2,
      failed_runs: 0,
    });
    expect(byName.get('test / server')).toMatchObject({
      configured: true,
      average_seconds: 35,
      total_runs: 2,
      failed_runs: 1,
      infra_errors: 0,
    });
    expect(byName.get('test / client')).toMatchObject({
      configured: true,
      total_runs: 3,
      failed_runs: 1,
      total_errors: 1,
      infra_errors: 1,
    });
    expect(byName.get('test / client')?.infra_error_rate).toBe(1);
    expect(byName.get('lint')).toMatchObject({
      configured: true,
      average_seconds: null,
      total_runs: 0,
    });
  });

  it('returns ci_config.error instead of failing when ci.yaml is invalid', async () => {
    const cwd = freshRepoWithCiYaml('version: [\n');
    const projectId = await freshProject(cwd);

    const res = await request.get(`/api/projects/${projectId}/ci-runs/stats`).expect(200);
    expect(res.body.ci_config).toMatchObject({
      found: true,
      version: null,
    });
    expect(res.body.ci_config.error).toMatch(/could not parse/i);
    expect(res.body.tests).toEqual([]);
  });
});
