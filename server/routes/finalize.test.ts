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
import { execFileSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type supertest from 'supertest';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';
import { getDb, getStmts } from '../db.js';
import { getRunnerJobLogsDb } from '../finalize/runner-logs-db.js';
import type { AppConfig, FinalizeRunStepRow } from '../types.js';
import { createFinalizeStepLogStore } from '../finalize/finalize-log-store.js';
import { appendRunnerJobLog, enqueueRunnerJob } from '../finalize/runner-queue.js';

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
}

function seedSession(sessionId: string, _projectId: string): void {
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
        mode, validated_head_sha
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      currentHeadSha: null,
      stale: false,
      flakeRecovered: [],
      flakeGate: { status: 'clean', reason: null },
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

  it('returns 200 + null without 404, even for arbitrary unknown session ids', async () => {
    // The endpoint never 404s — "no runs yet" is the normal first-load
    // state and the client branches on `run === null`, not on status code.
    const res = await request
      .get('/api/sessions/zzz-totally-fake-session-id/finalize-runs/latest')
      .expect(200);
    expect(res.body).toEqual({
      run: null,
      steps: [],
      currentHeadSha: null,
      stale: false,
      flakeRecovered: [],
      flakeGate: { status: 'clean', reason: null },
      phases: { checks: null, review: null },
    });
  });
});

describe('GET /api/sessions/:sessionId/finalize-runs/latest — staleness', () => {
  // Regression for "Stale code gets run on sessions": after the agent commits
  // a new fix, the latest finalize_runs row still carries the OLD head_sha.
  // Reading it (web panel or `finalize.sh latest`) made the agent treat an old
  // commit's failure as current and loop re-fixing forever. The endpoint now
  // compares the run's head_sha to the worktree's live HEAD and flags `stale`.
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'finalize-stale-'));
  });

  function makeGitRepo(): { dir: string; headSha: string } {
    const dir = mkdtempSync(join(tmpRoot, 'wt-'));
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir });
    run('init', '-q');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    run('commit', '-q', '--allow-empty', '-m', 'initial');
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
    return { dir, headSha };
  }

  function seedSessionWithWorktree(sessionId: string, worktreePath: string): void {
    getDb()
      .prepare(
        `INSERT INTO sessions (id, agent_id, name, worktree_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run(sessionId, `agent-${uuidv4().slice(0, 8)}`, 'Test session', worktreePath);
  }

  function seedRunWithHead(
    projectId: string,
    sessionId: string,
    headSha: string,
    opts: { status?: string; phase?: string | null; endedAt?: number | null } = {},
  ): string {
    const id = `run-${uuidv4().slice(0, 8)}`;
    const status = opts.status ?? 'failed';
    const phase = opts.phase === undefined ? 'review' : opts.phase;
    const endedAt =
      opts.endedAt === undefined ? (status === 'running' ? null : 2_000) : opts.endedAt;
    getDb()
      .prepare(
        `INSERT INTO finalize_runs (
          id, card_id, session_id, project_id, branch, head_sha,
          idempotency_key, status, phase, trigger_source, worktree_path,
          triggered_by_user_id, author_name, author_email,
          reviewer_verdict, active_seconds_consumed, started_at, ended_at, mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        `card-${uuidv4().slice(0, 8)}`,
        sessionId,
        projectId,
        'feature/x',
        headSha,
        `idem-${uuidv4()}`,
        status,
        phase,
        'ui_button',
        '/tmp/wt',
        'user-1',
        'Test User',
        'test@example.com',
        null,
        0,
        1_000,
        endedAt,
        'full',
      );
    return id;
  }

  it('flags stale=true when the run head_sha predates the worktree HEAD', async () => {
    const projectId = await freshProject();
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    const { dir, headSha } = makeGitRepo();
    seedSessionWithWorktree(sessionId, dir);
    // Run recorded against an OLD commit that no longer matches HEAD.
    seedRunWithHead(projectId, sessionId, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');

    const res = await request.get(`/api/sessions/${sessionId}/finalize-runs/latest`).expect(200);
    expect(res.body.currentHeadSha).toBe(headSha);
    expect(res.body.stale).toBe(true);
  });

  it('flags stale=false when the run head_sha matches the worktree HEAD', async () => {
    const projectId = await freshProject();
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    const { dir, headSha } = makeGitRepo();
    seedSessionWithWorktree(sessionId, dir);
    seedRunWithHead(projectId, sessionId, headSha);

    const res = await request.get(`/api/sessions/${sessionId}/finalize-runs/latest`).expect(200);
    expect(res.body.currentHeadSha).toBe(headSha);
    expect(res.body.stale).toBe(false);
  });

  it('does not flag an in-flight rebased run stale while it is still validating', async () => {
    const projectId = await freshProject();
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    const { dir } = makeGitRepo();
    seedSessionWithWorktree(sessionId, dir);
    seedRunWithHead(projectId, sessionId, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', {
      status: 'running',
      phase: 'tasks',
      endedAt: null,
    });

    const res = await request.get(`/api/sessions/${sessionId}/finalize-runs/latest`).expect(200);
    expect(res.body.currentHeadSha).toBeTruthy();
    expect(res.body.stale).toBe(false);
  });

  it('flags a non-ended dispatching run stale when its recorded head is obsolete', async () => {
    const projectId = await freshProject();
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    const { dir, headSha } = makeGitRepo();
    seedSessionWithWorktree(sessionId, dir);
    seedRunWithHead(projectId, sessionId, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', {
      status: 'dispatching',
      phase: 'rebase',
      endedAt: null,
    });

    const res = await request.get(`/api/sessions/${sessionId}/finalize-runs/latest`).expect(200);
    expect(res.body.currentHeadSha).toBe(headSha);
    expect(res.body.stale).toBe(true);
  });

  it('flags a non-ended queued run stale when its recorded head is obsolete', async () => {
    const projectId = await freshProject();
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    const { dir, headSha } = makeGitRepo();
    seedSessionWithWorktree(sessionId, dir);
    seedRunWithHead(projectId, sessionId, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', {
      status: 'queued',
      phase: null,
      endedAt: null,
    });

    const res = await request.get(`/api/sessions/${sessionId}/finalize-runs/latest`).expect(200);
    expect(res.body.currentHeadSha).toBe(headSha);
    expect(res.body.stale).toBe(true);
  });

  it('fails safe (stale=false) when the worktree HEAD cannot be resolved', async () => {
    const projectId = await freshProject();
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    // Point the session at a non-existent worktree so git rev-parse throws.
    seedSessionWithWorktree(sessionId, join(tmpRoot, 'does-not-exist'));
    seedRunWithHead(projectId, sessionId, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');

    const res = await request.get(`/api/sessions/${sessionId}/finalize-runs/latest`).expect(200);
    expect(res.body.currentHeadSha).toBeNull();
    expect(res.body.stale).toBe(false);
  });

  // Regression for support ticket 2dd6df35 ("CI module loading issues" —
  // queued test rows only appear after refreshing several times). The queued
  // step rows reach the live-checks panel only via this refetch, but the
  // endpoint spawned `git rev-parse HEAD` on every call, and that spawn stalls
  // under an active run's load. The UI now passes `includeStale=0` to skip the
  // spawn: a run whose head_sha is obsolete (which normally flags stale=true)
  // must return stale=false + currentHeadSha=null when the flag is off, proving
  // no git subprocess ran — while still returning the persisted step rows.
  it('skips the git HEAD spawn and returns steps immediately when includeStale=0', async () => {
    const projectId = await freshProject();
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    const { dir } = makeGitRepo();
    seedSessionWithWorktree(sessionId, dir);
    // Obsolete head_sha: with staleness on this would flag stale=true.
    const runId = seedRunWithHead(
      projectId,
      sessionId,
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      { status: 'running', phase: 'tasks', endedAt: null },
    );
    getStmts().upsertFinalizeRunStep.run(
      runId,
      1,
      'backend-tests / 0 / Backend tests (shard 0/3)',
      'queued',
      null,
      null,
      null,
      'backend-tests',
      '0',
    );

    const res = await request
      .get(`/api/sessions/${sessionId}/finalize-runs/latest?includeStale=0`)
      .expect(200);
    // Spawn skipped: no HEAD resolved, fail-safe stale=false despite the
    // obsolete head_sha that the default path would flag stale.
    expect(res.body.currentHeadSha).toBeNull();
    expect(res.body.stale).toBe(false);
    // Steps still come back so the live panel renders queued rows at once.
    expect(res.body.steps).toHaveLength(1);
    expect(res.body.steps[0].state).toBe('queued');
  });

  it('still computes staleness by default (no flag) for the agent CLI path', async () => {
    const projectId = await freshProject();
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    const { dir, headSha } = makeGitRepo();
    seedSessionWithWorktree(sessionId, dir);
    seedRunWithHead(projectId, sessionId, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');

    const res = await request.get(`/api/sessions/${sessionId}/finalize-runs/latest`).expect(200);
    expect(res.body.currentHeadSha).toBe(headSha);
    expect(res.body.stale).toBe(true);
  });

  it('treats includeStale=1 as staleness-on', async () => {
    const projectId = await freshProject();
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    const { dir, headSha } = makeGitRepo();
    seedSessionWithWorktree(sessionId, dir);
    seedRunWithHead(projectId, sessionId, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');

    const res = await request
      .get(`/api/sessions/${sessionId}/finalize-runs/latest?includeStale=1`)
      .expect(200);
    expect(res.body.currentHeadSha).toBe(headSha);
    expect(res.body.stale).toBe(true);
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

  it('serves step output from the log store when the step row records a blob', async () => {
    const projectId = await freshProject();
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    seedSession(sessionId, projectId);
    const runId = seedFinalizeRun({ projectId, sessionId });
    const stmts = getStmts();

    // Write the blob through the SAME local store the route reads from (keyed
    // by dataDir, which the test harness pins to AGENT_HUB_DATA_DIR).
    const config = {
      dataDir: process.env.AGENT_HUB_DATA_DIR as string,
      artifactsBucket: null,
      artifactsBucketRegion: null,
    } as unknown as AppConfig;
    const attempt = 'attempt-nonce-1';
    const persisted = await createFinalizeStepLogStore(config).write(
      runId,
      2,
      {
        truncated: true,
        totalLines: 9000,
        lines: [
          { stream: 'stdout', text: 'compiling…' },
          { stream: 'stderr', text: 'warning: deprecated API' },
        ],
      },
      attempt,
    );

    // Seed the step row + attach the location exactly as the runner does:
    // terminal state via the upsert, then the nonce (begin) + guarded attach.
    stmts.upsertFinalizeRunStep.run(runId, 2, 'E2E', 'passed', 0, 1000, 2000, 'e2e', null);
    stmts.beginFinalizeRunStepAttempt.run(attempt, runId, 2);
    stmts.attachFinalizeRunStepLog.run(
      persisted.storage_kind,
      persisted.storage_bucket,
      persisted.storage_region,
      persisted.key,
      persisted.lines,
      persisted.truncated ? 1 : 0,
      runId,
      2,
      attempt,
    );

    const res = await request
      .get(`/api/projects/${projectId}/finalize/${runId}/steps/2/output`)
      .expect(200);
    expect(res.body.lines.map((l: { text: string }) => l.text)).toEqual([
      'compiling…',
      'warning: deprecated API',
    ]);
    expect(res.body.truncated).toBe(true);
    expect(res.body.total_lines).toBe(9000);
  });

  it('serves remote runner spool output for a finalize step without a log blob', async () => {
    const projectId = await freshProject();
    const runId = seedFinalizeRun({ projectId, sessionId: null, mode: 'checks' });
    const stmts = getStmts();
    stmts.upsertFinalizeRunStep.run(
      runId,
      1,
      'component / shard 0 / tests',
      'running',
      null,
      1000,
      null,
      'component',
      'shard=0',
    );

    const queueJobId = enqueueRunnerJob({
      orgId: 'org-test',
      projectId,
      runId,
      jobId: 'component',
      matrixKey: 'shard=0',
      image: 'runner:latest',
      specJson: '{}',
      now: 2000,
    });
    appendRunnerJobLog({
      jobId: queueJobId,
      seq: 0,
      stepIndex: 1,
      stream: 'stdout',
      data: '\u001b[32mtests started\u001b[0m',
      now: 3000,
    });
    appendRunnerJobLog({
      jobId: queueJobId,
      seq: 1,
      stepIndex: 1,
      stream: 'stderr',
      data: 'warning from runner',
      now: 3001,
    });

    const res = await request
      .get(`/api/projects/${projectId}/finalize/${runId}/steps/1/output`)
      .expect(200);
    expect(res.body.lines).toEqual([
      { stream: 'stdout', text: 'tests started', created_at: new Date(3000).toISOString() },
      { stream: 'stderr', text: 'warning from runner', created_at: new Date(3001).toISOString() },
    ]);
    expect(res.body.truncated).toBe(false);
    expect(res.body.total_lines).toBe(2);
  });

  it('caps remote runner spool output and reports total lines', async () => {
    const projectId = await freshProject();
    const runId = seedFinalizeRun({ projectId, sessionId: null, mode: 'checks' });
    const stmts = getStmts();
    stmts.upsertFinalizeRunStep.run(
      runId,
      1,
      'component / shard 1 / tests',
      'running',
      null,
      1000,
      null,
      'component',
      'shard=1',
    );

    const queueJobId = enqueueRunnerJob({
      orgId: 'org-test',
      projectId,
      runId,
      jobId: 'component',
      matrixKey: 'shard=1',
      image: 'runner:latest',
      specJson: '{}',
      now: 2000,
    });
    const insert = getRunnerJobLogsDb().prepare(
      `INSERT INTO runner_job_logs (job_id, seq, step_index, stream, data, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const seedLogs = getRunnerJobLogsDb().transaction(() => {
      for (let i = 0; i < 5002; i++) {
        insert.run(queueJobId, i, 1, 'stdout', `line-${i}`, 3000 + i);
      }
    });
    seedLogs();

    const res = await request
      .get(`/api/projects/${projectId}/finalize/${runId}/steps/1/output`)
      .expect(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.total_lines).toBe(5002);
    expect(res.body.lines).toHaveLength(5000);
    expect(res.body.lines[0]).toMatchObject({ stream: 'stdout', text: 'line-0' });
    expect(res.body.lines[4958]).toMatchObject({ stream: 'stdout', text: 'line-4958' });
    expect(res.body.lines[4959].text).toContain('3 of 5002 lines omitted');
    expect(res.body.lines[4960]).toMatchObject({ stream: 'stdout', text: 'line-4962' });
    expect(res.body.lines[4999]).toMatchObject({ stream: 'stdout', text: 'line-5001' });
  });
});

describe('finalize_run_steps log-location lifecycle', () => {
  it('a stale attempt nonce cannot clobber a newer execution; the current nonce updates in place', async () => {
    const projectId = await freshProject();
    const sessionId = `sess-${uuidv4().slice(0, 8)}`;
    seedSession(sessionId, projectId);
    const runId = seedFinalizeRun({ projectId, sessionId });
    const stmts = getStmts();

    // Step 1 ran once (attempt A) and its log was attached.
    stmts.upsertFinalizeRunStep.run(runId, 1, 'E2E', 'passed', 0, 1000, 2000, 'e2e', null);
    stmts.beginFinalizeRunStepAttempt.run('attempt-A', runId, 1);
    stmts.attachFinalizeRunStepLog.run(
      'local',
      null,
      null,
      `finalize-logs/${runId}/1-attempt-A.json.gz`,
      5,
      0,
      runId,
      1,
      'attempt-A',
    );

    // Step 1 is RE-EXECUTED (attempt B): begin clears the prior location + sets
    // the new nonce. While B's upload is pending the row shows NO stale log.
    stmts.beginFinalizeRunStepAttempt.run('attempt-B', runId, 1);
    let row = stmts.getFinalizeRunStep.get(runId, 1) as FinalizeRunStepRow;
    expect(row.log_attempt).toBe('attempt-B');
    expect(row.log_key).toBeNull();

    // A's slow upload finally completes and tries to attach with its OLD nonce —
    // it must match no row (B owns the slot now).
    stmts.attachFinalizeRunStepLog.run(
      'local',
      null,
      null,
      `finalize-logs/${runId}/1-attempt-A.json.gz`,
      5,
      0,
      runId,
      1,
      'attempt-A',
    );
    row = stmts.getFinalizeRunStep.get(runId, 1) as FinalizeRunStepRow;
    expect(row.log_key).toBeNull(); // A could not clobber B

    // B's upload completes and attaches against the current nonce.
    const bKey = `finalize-logs/${runId}/1-attempt-B.json.gz`;
    stmts.attachFinalizeRunStepLog.run('local', null, null, bKey, 7, 0, runId, 1, 'attempt-B');
    row = stmts.getFinalizeRunStep.get(runId, 1) as FinalizeRunStepRow;
    expect(row.log_key).toBe(bKey);
    expect(row.log_lines).toBe(7);
  });
});

// `beforeEach` is here so the file matches the project's standard
// test-skeleton; nothing to reset between cases (every test seeds its
// own project + run/session pair via uuid).
beforeEach(() => {
  /* noop */
});
