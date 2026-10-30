import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUNNER_QUEUE_SCHEMA } from './runner-queue-schema.js';
import { RUNNER_JOB_LOGS_SCHEMA } from './runner-logs-db.js';
import {
  RUNNER_QUEUE_STEP_COUNT_SQL,
  RUNNER_QUEUE_STEP_HEAD_SQL,
  RUNNER_QUEUE_STEP_JOB_SQL,
  RUNNER_QUEUE_STEP_TAIL_SQL,
} from './step-output.js';

// The step-output endpoint runs these synchronously on the request thread. A
// full scan of runner_jobs (multi-KB spec_json per row) stalled prod's event
// loop for over a minute and 504'd every request, so pin the plans.
function plan(db: Database.Database, sql: string, params: Record<string, unknown>): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as { detail: string }[])
    .map((r) => r.detail)
    .join('\n');
}

describe('runner step-output query plans', () => {
  let orgs: Database.Database;
  let logs: Database.Database;

  beforeEach(() => {
    orgs = new Database(':memory:');
    orgs.exec(RUNNER_QUEUE_SCHEMA);
    logs = new Database(':memory:');
    logs.exec(RUNNER_JOB_LOGS_SCHEMA);
  });

  afterEach(() => {
    orgs.close();
    logs.close();
  });

  it('looks up the queue job through an index, not a table scan', () => {
    const detail = plan(orgs, RUNNER_QUEUE_STEP_JOB_SQL, {
      projectId: 'p',
      runId: 'r',
      jobId: 'j',
      matrixKey: '',
    });
    expect(detail).toContain('idx_runner_jobs_run_shard');
    expect(detail).not.toMatch(/SCAN runner_jobs/);
  });

  it.each([
    ['count', RUNNER_QUEUE_STEP_COUNT_SQL],
    ['head', RUNNER_QUEUE_STEP_HEAD_SQL],
    ['tail', RUNNER_QUEUE_STEP_TAIL_SQL],
  ])('reads %s frames via the (job_id, step_index, seq) index', (_name, sql) => {
    const detail = plan(logs, sql, { jobId: 'j', stepIndex: 1, limit: 10 });
    expect(detail).toMatch(/idx_runner_job_logs_step \(job_id=\? AND step_index=\?\)/);
    expect(detail).not.toMatch(/TEMP B-TREE/);
  });
});
