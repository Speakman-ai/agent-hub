/**
 * Integration tests for the finalize read-only inspection endpoints.
 *
 * Both endpoints are read-only at v0 — the orchestrator and the
 * reviewer-dispatch helper own every write to `finalize_runs` and
 * `reviewer_threads`. These tests seed rows directly via the real DB
 * (the prepared-statement registry is exposed by `getStmts()`) and drive
 * the live Express app through supertest, so the visibility gate +
 * route mounting is exercised exactly as production does it.
 */
import '../test/setup.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type supertest from 'supertest';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';
import { getDb, getStmts } from '../db.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

async function freshProject(): Promise<string> {
  const id = `finalize-test-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  return id;
}

interface SeedRunOpts {
  projectId: string;
  sessionId?: string | null;
  status?: string;
  verdict?: 'approved' | 'changes_requested' | null;
  startedAt?: number;
  mode?: 'full' | 'checks' | 'review';
  validatedHeadSha?: string | null;
  jobFilter?: string[] | null;
}

function seedSession(sessionId: string, projectId: string): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, agent_id, name, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(sessionId, `agent-${uuidv4().slice(0, 8)}`, 'Test session');
}

function seedFinalizeRun(opts: SeedRunOpts): string {
  const id = `run-${uuidv4().slice(0, 8)}`;
  const startedAt = opts.startedAt ?? Date.now();
  getDb()
    .prepare(
      `INSERT INTO finalize_runs (
        id, card_id, session_id, project_id, branch, head_sha,
        idempotency_key, status, phase, trigger_source, worktree_path,
        triggered_by_user_id, author_name, author_email,
        reviewer_verdict, active_seconds_consumed, started_at,
        mode, validated_head_sha, job_filter
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      `card-${uuidv4().slice(0, 8)}`,
      opts.sessionId ?? null,
      opts.projectId,
      'feature/x',
      `sha-${uuidv4().slice(0, 8)}`,
      `idem-${uuidv4()}`,
      opts.status ?? 'reviewing',
      'review',
      'ui_button',
      '/tmp/wt',
      'user-1',
      'Test User',
      'test@example.com',
      opts.verdict ?? null,
      0,
      startedAt,
      opts.mode ?? 'full',
      opts.validatedHeadSha ?? null,
      opts.jobFilter ? JSON.stringify(opts.jobFilter) : null,
    );
  return id;
}

interface SeedThread {
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  body: string;
  created_at?: number;
}

function seedThreads(runId: string, threads: SeedThread[]): void {
  const stmts = getStmts();
  for (const t of threads) {
    stmts.insertReviewerThread.run(
      uuidv4(),
      runId,
      t.file_path,
      t.line_start,
      t.line_end,
      t.body,
      'reviewer-agent',
      t.created_at ?? Date.now(),
    );
  }
}

describe('GET /api/projects/:projectId/finalize/:runId/reviewer-threads', () => {
  it('404 when the project does not exist', async () => {
    const res = await request
      .get('/api/projects/does-not-exist/finalize/anything/reviewer-threads')
      .expect(404);
    expect(res.body.error).toMatch(/project not found/i);
  });

  it('404 when the run id does not exist in this project', async () => {
    const projectId = await freshProject();
    const res = await request
      .get(`/api/projects/${projectId}/finalize/no-such-run/reviewer-threads`)
      .expect(404);
    expect(res.body.error).toMatch(/run not found/i);
  });

  it('404 when the run belongs to a different project (no leak)', async () => {
    const projectA = await freshProject();
    const projectB = await freshProject();
    const runId = seedFinalizeRun({ projectId: projectA });

    const res = await request
      .get(`/api/projects/${projectB}/finalize/${runId}/reviewer-threads`)
      .expect(404);
    expect(res.body.error).toMatch(/run not found/i);
  });

  it('returns empty threads + null verdict for a fresh run', async () => {
    const projectId = await freshProject();
    const runId = seedFinalizeRun({ projectId });

    const res = await request
      .get(`/api/projects/${projectId}/finalize/${runId}/reviewer-threads`)
      .expect(200);
    expect(res.body).toEqual({
      run_id: runId,
      reviewer_verdict: null,
      threads: [],
    });
  });

  it('returns threads grouped/ordered by file_path then line_start then created_at', async () => {
    const projectId = await freshProject();
    const runId = seedFinalizeRun({ projectId, verdict: 'changes_requested' });

    // Insert in scrambled order — the route must sort, not the client.
    seedThreads(runId, [
      { file_path: 'src/b.ts', line_start: 10, line_end: 12, body: '[7/10] b:10' },
      {
        file_path: 'src/a.ts',
        line_start: 42,
        line_end: 42,
        body: '[5/10] a:42 (second)',
        created_at: 200,
      },
      {
        file_path: 'src/a.ts',
        line_start: 42,
        line_end: 42,
        body: '[5/10] a:42 (first)',
        created_at: 100,
      },
      { file_path: 'src/a.ts', line_start: null, line_end: null, body: '[2/10] a file-level' },
      { file_path: 'src/a.ts', line_start: 5, line_end: 8, body: '[6/10] a:5-8' },
    ]);

    const res = await request
      .get(`/api/projects/${projectId}/finalize/${runId}/reviewer-threads`)
      .expect(200);
    expect(res.body.run_id).toBe(runId);
    expect(res.body.reviewer_verdict).toBe('changes_requested');

    const bodies = res.body.threads.map((t: { body: string }) => t.body);
    expect(bodies).toEqual([
      // file_path ASC: a.ts before b.ts.
      // Inside a.ts: line_start NULL first (sqlite NULLs sort before numbers
      // when ASC), then 5, then 42; on ties (the two 42s) created_at ASC.
      '[2/10] a file-level',
      '[6/10] a:5-8',
      '[5/10] a:42 (first)',
      '[5/10] a:42 (second)',
      '[7/10] b:10',
    ]);

    // Shape check on one row — author is always 'reviewer-agent' at v0.
    const sample = res.body.threads[1];
    expect(sample).toMatchObject({
      run_id: runId,
      file_path: 'src/a.ts',
      line_start: 5,
      line_end: 8,
      author: 'reviewer-agent',
    });
    expect(typeof sample.id).toBe('string');
    expect(typeof sample.created_at).toBe('number');
  });

  it('surfaces the approved verdict when the run is approved', async () => {
    const projectId = await freshProject();
    const runId = seedFinalizeRun({ projectId, verdict: 'approved' });
    const res = await request
      .get(`/api/projects/${projectId}/finalize/${runId}/reviewer-threads`)
      .expect(200);
    expect(res.body.reviewer_verdict).toBe('approved');
    expect(res.body.threads).toEqual([]);
  });
});

describe('GET /api/sessions/:sessionId/finalize-runs/latest', () => {
  it('returns { run: null } when the session has no finalize runs', async () => {
    const res = await request
      .get('/api/sessions/sess-with-no-runs/finalize-runs/latest')
      .expect(200);
    expect(res.body).toEqual({
      run: null,
      steps: [],
      phases: { checks: null, review: null },
    });
  });

  it('returns persisted steps with the latest run', async () => {
    const projectId = await freshProject();
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    const runId = seedFinalizeRun({ projectId, sessionId, status: 'running', startedAt: 2_000 });
    getStmts().upsertFinalizeRunStep.run(
      runId,
      1,
      'backend-tests',
      'failed',
      127,
      1000,
      2000,
      null,
      null,
    );

    const res = await request.get(`/api/sessions/${sessionId}/finalize-runs/latest`).expect(200);
    expect(res.body.steps).toHaveLength(1);
    expect(res.body.steps[0].name).toBe('backend-tests');
    expect(res.body.steps[0].state).toBe('failed');
  });

  it('returns the most-recent run by started_at when several exist', async () => {
    const projectId = await freshProject();
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    const older = seedFinalizeRun({ projectId, sessionId, startedAt: 1_000 });
    const newer = seedFinalizeRun({ projectId, sessionId, startedAt: 2_000 });

    const res = await request.get(`/api/sessions/${sessionId}/finalize-runs/latest`).expect(200);
    expect(res.body.run).toBeTruthy();
    expect(res.body.run.id).toBe(newer);
    expect(res.body.run.id).not.toBe(older);
    expect(res.body.run.session_id).toBe(sessionId);
    expect(res.body.run.project_id).toBe(projectId);
  });

  it('surfaces only the checks phase when a checks-only run reached ready_to_push', async () => {
    const projectId = await freshProject();
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    seedFinalizeRun({
      projectId,
      sessionId,
      mode: 'checks',
      status: 'ready_to_push',
      validatedHeadSha: 'sha-checks',
      startedAt: 1_000,
    });

    const res = await request.get(`/api/sessions/${sessionId}/finalize-runs/latest`).expect(200);
    expect(res.body.phases.checks).toMatchObject({
      status: 'ready_to_push',
      mode: 'checks',
      validated_head_sha: 'sha-checks',
    });
    expect(res.body.phases.review).toBeNull();
  });

  it('surfaces both phases from a single full run with the same validated head', async () => {
    const projectId = await freshProject();
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    seedFinalizeRun({
      projectId,
      sessionId,
      mode: 'full',
      status: 'ready_to_push',
      validatedHeadSha: 'sha-full',
      startedAt: 1_000,
    });

    const res = await request.get(`/api/sessions/${sessionId}/finalize-runs/latest`).expect(200);
    expect(res.body.phases.checks?.validated_head_sha).toBe('sha-full');
    expect(res.body.phases.review?.validated_head_sha).toBe('sha-full');
    expect(res.body.phases.checks?.run_id).toBe(res.body.phases.review?.run_id);
  });

  it('resolves checks and review phases from two separate phase-scoped runs', async () => {
    const projectId = await freshProject();
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    seedFinalizeRun({
      projectId,
      sessionId,
      mode: 'checks',
      status: 'ready_to_push',
      validatedHeadSha: 'sha-1',
      startedAt: 1_000,
    });
    seedFinalizeRun({
      projectId,
      sessionId,
      mode: 'review',
      status: 'ready_to_push',
      validatedHeadSha: 'sha-1',
      startedAt: 2_000,
    });

    const res = await request.get(`/api/sessions/${sessionId}/finalize-runs/latest`).expect(200);
    expect(res.body.phases.checks?.mode).toBe('checks');
    expect(res.body.phases.review?.mode).toBe('review');
    expect(res.body.phases.checks?.validated_head_sha).toBe('sha-1');
    expect(res.body.phases.review?.validated_head_sha).toBe('sha-1');
  });

  it('excludes a job-filtered debug run from the checks phase summary', async () => {
    // A single-job "Run Tests" run must never flip the "Tested" badge: even
    // when it parked at ready_to_push more recently than the full run, the
    // phase picker has to keep returning the FULL run as the checks proof.
    const projectId = await freshProject();
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    const fullRunId = seedFinalizeRun({
      projectId,
      sessionId,
      mode: 'checks',
      status: 'ready_to_push',
      validatedHeadSha: 'sha-full',
      startedAt: 1_000,
    });
    // A later partial run for one job, also parked — must be ignored.
    seedFinalizeRun({
      projectId,
      sessionId,
      mode: 'checks',
      status: 'ready_to_push',
      validatedHeadSha: 'sha-partial',
      jobFilter: ['e2e'],
      startedAt: 2_000,
    });

    const res = await request.get(`/api/sessions/${sessionId}/finalize-runs/latest`).expect(200);
    // The phase summary stays pinned to the full-suite run.
    expect(res.body.phases.checks?.run_id).toBe(fullRunId);
    expect(res.body.phases.checks?.validated_head_sha).toBe('sha-full');
    // ...even though the partial run is the latest overall row.
    expect(res.body.run?.validated_head_sha).toBe('sha-partial');
  });

  it('returns no checks phase when only a job-filtered run exists', async () => {
    const projectId = await freshProject();
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    seedFinalizeRun({
      projectId,
      sessionId,
      mode: 'checks',
      status: 'ready_to_push',
      validatedHeadSha: 'sha-partial',
      jobFilter: ['lint'],
      startedAt: 1_000,
    });

    const res = await request.get(`/api/sessions/${sessionId}/finalize-runs/latest`).expect(200);
    expect(res.body.phases.checks).toBeNull();
  });

  it('returns 200 + null without 404, even for arbitrary unknown session ids', async () => {
    // The endpoint never 404s — "no runs yet" is the normal first-load
    // state and the client branches on `run === null`, not on status code.
    const res = await request
      .get('/api/sessions/zzz-totally-fake-session-id/finalize-runs/latest')
      .expect(200);
    expect(res.body).toEqual({
      run: null,
      steps: [],
      phases: { checks: null, review: null },
    });
  });
});

describe('GET /api/sessions/:sessionId/finalize/ci-jobs', () => {
  function seedSessionWithWorktree(sessionId: string, worktreePath: string): void {
    getDb()
      .prepare(
        `INSERT INTO sessions (id, agent_id, name, worktree_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run(sessionId, `agent-${uuidv4().slice(0, 8)}`, 'Test session', worktreePath);
  }

  function writeCiYaml(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'finalize-cijobs-'));
    mkdirSync(join(dir, '.agent-hub'), { recursive: true });
    writeFileSync(join(dir, '.agent-hub', 'ci.yaml'), contents);
    return dir;
  }

  it('returns no_worktree when the session has no worktree path', async () => {
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    seedSession(sessionId, await freshProject());
    const res = await request.get(`/api/sessions/${sessionId}/finalize/ci-jobs`).expect(200);
    expect(res.body).toEqual({ version: null, jobs: [], error: 'no_worktree' });
  });

  it('lists v2 jobs with their needs from the worktree ci.yaml', async () => {
    const worktree = writeCiYaml(`
version: 2
on: [finalize]
jobs:
  build:
    runs-on: host
    steps:
      - run: npm run build
  test:
    runs-on: host
    needs: [build]
    steps:
      - run: npm test
`);
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    seedSessionWithWorktree(sessionId, worktree);

    const res = await request.get(`/api/sessions/${sessionId}/finalize/ci-jobs`).expect(200);
    expect(res.body.version).toBe(2);
    expect(res.body.error).toBeNull();
    const byId = Object.fromEntries(res.body.jobs.map((j: { id: string }) => [j.id, j]));
    expect(Object.keys(byId).sort()).toEqual(['build', 'test']);
    expect(byId.test.needs).toEqual(['build']);
    expect(byId.build.needs).toEqual([]);
  });

  it('returns an empty job list for a v1 (sequential-steps) config', async () => {
    const worktree = writeCiYaml(`
version: 1
on: [finalize]
steps:
  - run: npm test
`);
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    seedSessionWithWorktree(sessionId, worktree);

    const res = await request.get(`/api/sessions/${sessionId}/finalize/ci-jobs`).expect(200);
    expect(res.body).toEqual({ version: 1, jobs: [], error: null });
  });
});

describe('GET /api/projects/:projectId/finalize/:runId/steps/:stepIndex/output', () => {
  it('returns log lines for a step', async () => {
    const projectId = await freshProject();
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    seedSession(sessionId, projectId);
    const runId = seedFinalizeRun({ projectId, sessionId });
    const stmts = getStmts();
    const msgId = `msg-${uuidv4().slice(0, 8)}`;
    stmts.addMessage.run(
      msgId,
      sessionId,
      'system',
      '[stderr] command not found',
      null,
      null,
      null,
      JSON.stringify({
        kind: 'finalize_step_output',
        runId,
        stepIndex: 1,
        stream: 'stderr',
      }),
      null,
      null,
      null,
    );

    const res = await request
      .get(`/api/projects/${projectId}/finalize/${runId}/steps/1/output`)
      .expect(200);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].text).toBe('command not found');
  });
});

// `beforeEach` is here so the file matches the project's standard
// test-skeleton; nothing to reset between cases (every test seeds its
// own project + run/session pair via uuid).
beforeEach(() => {
  /* noop */
});
