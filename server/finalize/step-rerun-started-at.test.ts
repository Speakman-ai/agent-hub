/**
 * Regression: "These have been running for hours" (support card be654175).
 *
 * A Finalize fix round re-runs checks by re-queuing the SAME
 * (run_id, step_index) / (run_id, job_id, matrix_key) rows. The step/job
 * upserts used `started_at = COALESCE(existing, excluded)` — first write wins
 * — so after N fix rounds every row still carried its ROUND-1 start stamp.
 * The client renders `now - started_at` for running rows and
 * `ended_at - started_at` for terminal ones, so a run in its 5th round showed
 * every job "running" for 2h+ of cumulative wall-clock (including a passed
 * flake8 lint at "2h 4m") when the actual round-5 executions were minutes old.
 *
 * The fixed model makes started_at per-EXECUTION and display-only:
 *   - re-queue (state='queued')  → reset to NULL (fresh round, fresh clock)
 *   - start    (state='running') → overwrite with this execution's stamp
 *
 * Execution IDENTITY is a per-execution nonce, NOT the timestamp (a
 * retry/fix-round restart can land in the same millisecond, so timestamps
 * can collide):
 *   - steps: the `log_attempt` nonce minted by beginFinalizeRunStepAttempt;
 *     terminal writes go through finishFinalizeRunStepIfAttempt, which only
 *     applies while the row is still `running` under the SAME nonce.
 *   - jobs: the new `attempt` nonce column; the 'running' write mints it and
 *     the upsert only applies a terminal write whose nonce matches (null-safe
 *     `IS`, so fail-fast `skipped` NULL-vs-NULL passes).
 * A delayed terminal from a superseded execution therefore matches zero rows.
 *
 * These tests run against the REAL prepared statements from db.ts (live app
 * DB via the test harness), not a mirrored SQL copy, so drift is impossible.
 */
import '../test/setup.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';
import type { Stmts } from '../types.js';

let stmts: Stmts;

beforeAll(async () => {
  await getRequest();
  stmts = (await import('../db.js')).stmts!;
});

function seedRun(): string {
  const runId = uuidv4();
  stmts.insertFinalizeRun.run(
    runId,
    'card-rerun-test',
    null,
    'agent-hub',
    'main',
    uuidv4().replace(/-/g, '').padEnd(40, '0').slice(0, 40),
    `rerun-test|${runId}`,
    'running',
    'tasks',
    'ui_button',
    null,
    'system',
    'Agent Hub CI',
    'ci@agent-hub.local',
    null,
    Date.now(),
    'full',
    null,
  );
  return runId;
}

interface Row {
  state: string;
  exit_code: number | null;
  started_at: number | null;
  ended_at: number | null;
}

function readStep(runId: string): Row {
  const rows = stmts.listFinalizeRunStepsForRun.all(runId) as Row[];
  expect(rows).toHaveLength(1);
  return rows[0];
}

function readJob(runId: string): Row {
  const rows = stmts.listFinalizeRunJobsForRun.all(runId) as Row[];
  expect(rows).toHaveLength(1);
  return rows[0];
}

const R1_START = 1_000_000;
const R1_END = 1_360_000; // round 1 ran 6 min
const R2_START = 9_000_000; // round 2 starts ~2h13m later
const R2_END = 9_240_000; // round 2 ran 4 min

describe('finalize step started_at + terminal identity across fix rounds', () => {
  function upsertStep(
    runId: string,
    state: string,
    exitCode: number | null,
    startedAt: number | null,
    endedAt: number | null,
  ): void {
    stmts.upsertFinalizeRunStep.run(
      runId,
      1,
      'backend-tests / 2 / Backend tests (shard 2/3)',
      state,
      exitCode,
      startedAt,
      endedAt,
      'backend-tests',
      '2',
    );
  }

  /** Mirrors announceStepStart: running upsert + attempt-nonce mint. */
  function startStep(runId: string, startedAt: number): string {
    upsertStep(runId, 'running', null, startedAt, null);
    const attempt = uuidv4();
    stmts.beginFinalizeRunStepAttempt.run(attempt, runId, 1);
    return attempt;
  }

  /** Mirrors announceStepEnd: nonce-guarded terminal write. */
  function finishStep(
    runId: string,
    attempt: string,
    state: 'passed' | 'failed',
    exitCode: number,
    endedAt: number,
  ): number {
    const res = stmts.finishFinalizeRunStepIfAttempt.run(
      state,
      exitCode,
      endedAt,
      runId,
      1,
      attempt,
    ) as { changes: number };
    return res.changes;
  }

  it('re-queue resets the clock and the next round overwrites the stamp (the bug)', () => {
    const runId = seedRun();
    // Round 1: queued → running → passed.
    upsertStep(runId, 'queued', null, null, null);
    const a1 = startStep(runId, R1_START);
    expect(readStep(runId)).toMatchObject({ state: 'running', started_at: R1_START });
    expect(finishStep(runId, a1, 'passed', 0, R1_END)).toBe(1);
    expect(readStep(runId)).toMatchObject({
      state: 'passed',
      started_at: R1_START,
      ended_at: R1_END,
    });

    // Round 2 re-queues the same row: the round-1 stamp must NOT survive,
    // else a queued row still reads as hours old.
    upsertStep(runId, 'queued', null, null, null);
    expect(readStep(runId)).toMatchObject({ state: 'queued', started_at: null, ended_at: null });

    // Round 2 starts: the fresh stamp must WIN. Before the fix,
    // COALESCE(existing, excluded) kept R1_START, so the UI showed the step
    // "running" for the cumulative wall-clock of every prior round.
    const a2 = startStep(runId, R2_START);
    expect(readStep(runId)).toMatchObject({ state: 'running', started_at: R2_START });

    expect(finishStep(runId, a2, 'passed', 0, R2_END)).toBe(1);
    const row = readStep(runId);
    expect(row).toMatchObject({ state: 'passed', started_at: R2_START, ended_at: R2_END });
    // Displayed duration is the round-2 execution (4 min), not 2h17m.
    expect(row.ended_at! - row.started_at!).toBe(R2_END - R2_START);
  });

  it('rejects a delayed terminal from a superseded execution — even a same-millisecond restart', () => {
    const runId = seedRun();
    upsertStep(runId, 'queued', null, null, null);
    const a1 = startStep(runId, R1_START);

    // The row is re-queued (round boundary). The stale round-1 terminal
    // arrives while the row is queued: the nonce is unchanged (only a new
    // start re-mints it), so the state='running' conjunct is what rejects it.
    upsertStep(runId, 'queued', null, null, null);
    expect(finishStep(runId, a1, 'failed', 1, R1_END)).toBe(0);
    expect(readStep(runId)).toMatchObject({
      state: 'queued',
      exit_code: null,
      started_at: null,
      ended_at: null,
    });

    // Round 2 restarts IN THE SAME MILLISECOND as round 1 (started_at is an
    // identical stamp — a timestamp identity would collide here). The stale
    // round-1 terminal must still be rejected: identity is the nonce.
    const a2 = startStep(runId, R1_START);
    expect(a2).not.toBe(a1);
    expect(finishStep(runId, a1, 'failed', 1, R1_END + 5_000)).toBe(0);
    expect(readStep(runId)).toMatchObject({
      state: 'running',
      exit_code: null,
      started_at: R1_START,
      ended_at: null,
    });

    // The CURRENT execution's terminal (matching nonce) still lands, and a
    // duplicate replay of it after that is a no-op (state no longer running).
    expect(finishStep(runId, a2, 'passed', 0, R2_END)).toBe(1);
    expect(readStep(runId)).toMatchObject({
      state: 'passed',
      started_at: R1_START,
      ended_at: R2_END,
    });
    expect(finishStep(runId, a2, 'failed', 1, R2_END + 1)).toBe(0);
    expect(readStep(runId)).toMatchObject({ state: 'passed', exit_code: 0 });
  });
});

describe('finalize job started_at + attempt nonce across fix rounds', () => {
  function upsertJob(
    runId: string,
    state: string,
    exitCode: number | null,
    startedAt: number | null,
    endedAt: number | null,
    attempt: string | null,
  ): void {
    stmts.upsertFinalizeRunJob.run(
      runId,
      'e2e',
      'Inspection',
      state,
      exitCode,
      startedAt,
      endedAt,
      attempt,
    );
  }

  it('a later round overwrites the job start stamp; the matching-nonce terminal carries it', () => {
    const runId = seedRun();
    const a1 = uuidv4();
    // Round 1: queued → running (mints nonce) → passed (echoes nonce).
    upsertJob(runId, 'queued', null, null, null, null);
    upsertJob(runId, 'running', null, R1_START, null, a1);
    upsertJob(runId, 'passed', 0, R1_START, R1_END, a1);
    expect(readJob(runId)).toMatchObject({
      state: 'passed',
      started_at: R1_START,
      ended_at: R1_END,
    });

    // Round 2 re-queue resets clock + nonce; the new execution's writes win.
    const a2 = uuidv4();
    upsertJob(runId, 'queued', null, null, null, null);
    expect(readJob(runId)).toMatchObject({ state: 'queued', started_at: null, ended_at: null });
    upsertJob(runId, 'running', null, R2_START, null, a2);
    expect(readJob(runId)).toMatchObject({ state: 'running', started_at: R2_START });
    upsertJob(runId, 'failed', 1, R2_START, R2_END, a2);
    expect(readJob(runId)).toMatchObject({
      state: 'failed',
      started_at: R2_START,
      ended_at: R2_END,
    });
  });

  it('rejects a delayed terminal from a superseded execution — even a same-millisecond restart', () => {
    const runId = seedRun();
    const a1 = uuidv4();
    upsertJob(runId, 'queued', null, null, null, null);
    upsertJob(runId, 'running', null, R1_START, null, a1);

    // Runner dies; the job is re-queued. The abandoned execution's terminal
    // arrives against the re-queued row: nonce a1 vs NULL → rejected.
    upsertJob(runId, 'queued', null, null, null, null);
    upsertJob(runId, 'failed', -1, R1_START, R1_END, a1);
    expect(readJob(runId)).toMatchObject({
      state: 'queued',
      exit_code: null,
      started_at: null,
      ended_at: null,
    });

    // Restart lands in the SAME millisecond (identical started_at — a
    // timestamp identity would collide). The stale terminal still loses:
    // identity is the nonce.
    const a2 = uuidv4();
    upsertJob(runId, 'running', null, R1_START, null, a2);
    upsertJob(runId, 'failed', -1, R1_START, R1_END, a1);
    expect(readJob(runId)).toMatchObject({
      state: 'running',
      exit_code: null,
      started_at: R1_START,
      ended_at: null,
    });

    // The current execution's terminal (matching nonce) applies.
    upsertJob(runId, 'passed', 0, R1_START, R2_END, a2);
    expect(readJob(runId)).toMatchObject({
      state: 'passed',
      started_at: R1_START,
      ended_at: R2_END,
    });
  });

  it('rejects a duplicate/replayed terminal from the SAME execution (already-terminal row)', () => {
    const runId = seedRun();
    const a1 = uuidv4();
    upsertJob(runId, 'queued', null, null, null, null);
    upsertJob(runId, 'running', null, R1_START, null, a1);
    upsertJob(runId, 'passed', 0, R1_START, R1_END, a1);
    expect(readJob(runId)).toMatchObject({ state: 'passed', exit_code: 0 });

    // A replay of the same execution's terminal carries a MATCHING nonce —
    // the nonce alone cannot reject it. The live-state conjunct
    // (state IN ('queued','running')) must: the row is already terminal, so
    // the replay is a no-op and can never flip passed → failed.
    upsertJob(runId, 'failed', 1, R1_START, R1_END + 5_000, a1);
    expect(readJob(runId)).toMatchObject({
      state: 'passed',
      exit_code: 0,
      started_at: R1_START,
      ended_at: R1_END,
    });

    // Same for a terminalized-by-skip row: a matching-NULL-nonce skipped
    // replay is a no-op once the row is terminal.
    const runB = seedRun();
    upsertJob(runB, 'queued', null, null, null, null);
    upsertJob(runB, 'skipped', null, null, R1_END, null);
    expect(readJob(runB)).toMatchObject({ state: 'skipped', ended_at: R1_END });
    upsertJob(runB, 'failed', 1, null, R1_END + 5_000, null);
    expect(readJob(runB)).toMatchObject({ state: 'skipped', ended_at: R1_END });
  });

  it('a job skipped after a re-queue shows no phantom duration', () => {
    const runId = seedRun();
    const a1 = uuidv4();
    // Round 1 ran the job to completion.
    upsertJob(runId, 'queued', null, null, null, null);
    upsertJob(runId, 'running', null, R1_START, null, a1);
    upsertJob(runId, 'passed', 0, R1_START, R1_END, a1);

    // Round 2 re-queues it, then fail-fast skips it (markSkipped passes NULL
    // started_at + nonce; NULL IS NULL passes the guard). started_at must
    // stay NULL — before the fix it resurrected R1_START and the skipped row
    // displayed an hours-long duration.
    upsertJob(runId, 'queued', null, null, null, null);
    upsertJob(runId, 'skipped', null, null, R2_END, null);
    expect(readJob(runId)).toMatchObject({
      state: 'skipped',
      started_at: null,
      ended_at: R2_END,
    });
  });
});
