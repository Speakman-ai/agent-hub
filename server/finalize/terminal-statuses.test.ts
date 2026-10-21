import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import type Database from 'better-sqlite3';
import { initDb, getDb, getStmts } from '../db.js';
import type { Stmts } from '../types.js';
import { failStuckFinalizeRunsOnBoot } from './boot-recovery.js';
import { FINALIZE_TERMINAL_STATUSES } from './terminal-statuses.js';
import {
  repairPushCiSucceededRuns,
  PUSH_CI_SUCCEEDED_REPAIR_MARKER,
} from '../migrations/repair-push-ci-succeeded-runs.js';

const SWEEP_REASON = 'Finalize run interrupted (server restart or crash)';

describe('Finalize terminal statuses', () => {
  let dataDir: string;
  let db: Database.Database;
  let stmts: Stmts;

  beforeAll(() => {
    dataDir = path.join(
      os.tmpdir(),
      `agent-hub-terminal-statuses-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dataDir, { recursive: true });
    initDb(dataDir);
    db = getDb();
    stmts = getStmts();
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function insertRun(id: string, status: string, triggerSource: string, failureReason?: string) {
    db.prepare(
      `INSERT INTO finalize_runs
         (id, card_id, session_id, project_id, branch, head_sha, idempotency_key, status,
          trigger_source, triggered_by_user_id, author_name, author_email, failure_reason,
          started_at, ended_at)
       VALUES (?, 'card', ?, 'p', 'main', 'sha', ?, ?, ?, 'u', 'n', 'e', ?, 1000, ?)`,
    ).run(
      id,
      `s-${id}`,
      `k-${id}`,
      status,
      triggerSource,
      failureReason ?? null,
      status === 'running' ? null : 2000,
    );
  }

  function insertJob(runId: string, state: string) {
    db.prepare(
      `INSERT INTO finalize_run_jobs (run_id, job_id, matrix_key, state, started_at, ended_at)
       VALUES (?, ?, '', ?, 1000, 2000)`,
    ).run(runId, `job-${Math.random().toString(36).slice(2)}`, state);
  }

  function statusOf(id: string) {
    return db.prepare('SELECT status, failure_reason FROM finalize_runs WHERE id = ?').get(id) as {
      status: string;
      failure_reason: string | null;
    };
  }

  it('includes push-CI succeeded', () => {
    expect(FINALIZE_TERMINAL_STATUSES).toContain('succeeded');
  });

  it('boot sweep leaves a green push-CI run alone and fails in-flight runs', () => {
    insertRun('green', 'succeeded', 'git_push');
    insertRun('live', 'running', 'agent_block');
    failStuckFinalizeRunsOnBoot(stmts);
    expect(statusOf('green')).toEqual({ status: 'succeeded', failure_reason: null });
    expect(statusOf('live').status).toBe('infra_error');
  });

  it('every terminal-status NOT IN list in db.ts covers every terminal status', () => {
    const src = readFileSync(path.join(__dirname, '..', 'db.ts'), 'utf8');
    const lists = [...src.matchAll(/status NOT IN\s*\(([^)]*'pushed'[^)]*)\)/g)].map((m) => m[1]);
    for (const list of lists) {
      for (const s of FINALIZE_TERMINAL_STATUSES) expect(list).toContain(`'${s}'`);
    }
  });

  it('repair restores mislabeled green push-CI runs only', () => {
    rmSync(path.join(dataDir, PUSH_CI_SUCCEEDED_REPAIR_MARKER), { force: true });
    insertRun('swept-green', 'infra_error', 'git_push', SWEEP_REASON);
    insertJob('swept-green', 'passed');
    insertJob('swept-green', 'passed');
    insertRun('swept-red', 'infra_error', 'git_push', SWEEP_REASON);
    insertJob('swept-red', 'passed');
    insertJob('swept-red', 'running');
    insertRun('session-run', 'infra_error', 'agent_block', SWEEP_REASON);
    insertJob('session-run', 'passed');

    const r = repairPushCiSucceededRuns({ db, dataDir });
    expect(r).toEqual({ ran: true, restored: 1 });
    expect(statusOf('swept-green')).toEqual({ status: 'succeeded', failure_reason: null });
    expect(statusOf('swept-red').status).toBe('infra_error');
    expect(statusOf('session-run').status).toBe('infra_error');
    expect(repairPushCiSucceededRuns({ db, dataDir }).ran).toBe(false);
  });
});
