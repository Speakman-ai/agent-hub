/**
 * Regression coverage for the runtime stuck-run reaper.
 *
 * The bug it guards: a transient runner-lease-expiry blip (no Hub restart) left
 * two autonomous (`agent_block`) Finalize runs hung in `status=running` forever
 * — steps stranded `queued`, nothing executing, no live orchestrator, and
 * nothing on the steady-state path ever cleaned them up (boot-recovery needs a
 * restart; the stall watchdog only arms in live mode; the container reaper never
 * touches the row). These tests pin the exact shapes of those two runs as
 * reapable, and pin the healthy shapes that must NEVER be reaped.
 */
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Stmts } from '../types.js';
import {
  classifyRuntimeStuckRun,
  runStuckRunReaper,
  failureReasonForStuckRun,
  DEFAULT_RUNTIME_STUCK_RUN_CONFIG,
  type RuntimeStuckRunCandidate,
} from './stuck-run-reaper.js';
import { stuckRunProgressClockSql } from './stuck-run-clock-sql.js';

const CONFIG = DEFAULT_RUNTIME_STUCK_RUN_CONFIG;
const NOW = 1_782_400_000_000;
const MIN = 60_000;
/** A step that has never run: dispatched `queued`, no timestamps yet. */
const NO_TIMES = { started_at: null, ended_at: null };

function candidate(over: Partial<RuntimeStuckRunCandidate> = {}): RuntimeStuckRunCandidate {
  return {
    id: 'run-1',
    status: 'running',
    session_id: 'sess-1',
    card_id: 'card-1',
    project_id: 'agent-hub',
    head_sha: 'abc123',
    started_at: NOW - 40 * MIN,
    last_activity_ms: NOW - 40 * MIN,
    queued_steps: 1,
    running_steps: 0,
    ...over,
  };
}

const NEVER_LIVE = () => false;
const ALWAYS_LIVE = () => true;

describe('classifyRuntimeStuckRun', () => {
  it('reaps the orphaned shape: unregistered, idle, stranded queued step, nothing running', () => {
    // Deployment Phase 2 run 8d690e6c: 14 passed + 1 queued (server 3/3), idle ~9min.
    const c = candidate({ queued_steps: 1, running_steps: 0, last_activity_ms: NOW - 9 * MIN });
    expect(classifyRuntimeStuckRun(c, { nowMs: NOW, isLive: NEVER_LIVE, config: CONFIG })).toBe(
      'orphaned',
    );
  });

  it('reaps the hung shape: still registered but idle past the backstop with queued work', () => {
    // Stop Button run 3115fa64: 11 passed + 4 queued, idle ~25min, orchestrator hung (registered).
    const c = candidate({ queued_steps: 4, running_steps: 0, last_activity_ms: NOW - 25 * MIN });
    expect(classifyRuntimeStuckRun(c, { nowMs: NOW, isLive: ALWAYS_LIVE, config: CONFIG })).toBe(
      'hung',
    );
  });

  it('NEVER reaps a run with a step actively running (a legitimately slow shard)', () => {
    const c = candidate({ running_steps: 1, queued_steps: 2, last_activity_ms: NOW - 60 * MIN });
    expect(
      classifyRuntimeStuckRun(c, { nowMs: NOW, isLive: NEVER_LIVE, config: CONFIG }),
    ).toBeNull();
    expect(
      classifyRuntimeStuckRun(c, { nowMs: NOW, isLive: ALWAYS_LIVE, config: CONFIG }),
    ).toBeNull();
  });

  it('NEVER reaps a run with no stranded queued work (between phases / finishing)', () => {
    const c = candidate({ queued_steps: 0, running_steps: 0, last_activity_ms: NOW - 60 * MIN });
    expect(
      classifyRuntimeStuckRun(c, { nowMs: NOW, isLive: NEVER_LIVE, config: CONFIG }),
    ).toBeNull();
  });

  it('does NOT reap a freshly-orphaned run still inside the orphan grace window', () => {
    const c = candidate({ last_activity_ms: NOW - 2 * MIN });
    expect(
      classifyRuntimeStuckRun(c, { nowMs: NOW, isLive: NEVER_LIVE, config: CONFIG }),
    ).toBeNull();
  });

  it('does NOT reap a live run merely waiting on fleet capacity below the hung backstop', () => {
    // Registered + queued + idle past the SHORT orphan window but below the hung
    // backstop → a run queued for a runner, not a stall. Must be left alone.
    const c = candidate({
      queued_steps: 3,
      running_steps: 0,
      last_activity_ms: NOW - (CONFIG.orphanIdleMs + MIN),
    });
    expect(CONFIG.orphanIdleMs + MIN).toBeLessThan(CONFIG.hungIdleMs);
    expect(
      classifyRuntimeStuckRun(c, { nowMs: NOW, isLive: ALWAYS_LIVE, config: CONFIG }),
    ).toBeNull();
  });

  it('NEVER reaps a pre-start run on the happy path despite the orphaned shape', () => {
    // A not-yet-started run waiting to begin shares the reapable shape: dispatched
    // `queued` steps, nothing `running`, no abort handle registered yet, and it
    // can sit idle past orphanIdleMs while queued for capacity. Gating on
    // status='running' is what stops the cron failing a pending run.
    const shape = {
      queued_steps: 5,
      running_steps: 0,
      last_activity_ms: NOW - 20 * MIN, // idle past BOTH thresholds
    };
    for (const status of ['queued', 'rebasing', 'reviewing', 'dispatching'] as const) {
      const c = candidate({ status, ...shape });
      expect(
        classifyRuntimeStuckRun(c, { nowMs: NOW, isLive: NEVER_LIVE, config: CONFIG }),
      ).toBeNull();
      expect(
        classifyRuntimeStuckRun(c, { nowMs: NOW, isLive: ALWAYS_LIVE, config: CONFIG }),
      ).toBeNull();
    }
  });

  it('guards against clock skew (future-stamped activity)', () => {
    const c = candidate({ last_activity_ms: NOW + 5 * MIN });
    expect(
      classifyRuntimeStuckRun(c, { nowMs: NOW, isLive: NEVER_LIVE, config: CONFIG }),
    ).toBeNull();
  });
});

describe('runStuckRunReaper tick', () => {
  function fakeStmts(candidates: RuntimeStuckRunCandidate[], failChanges = 1) {
    return {
      selectRuntimeStuckFinalizeRunCandidates: { all: vi.fn(() => candidates) },
      failRuntimeStuckFinalizeRun: { run: vi.fn(() => ({ changes: failChanges })) },
      failRuntimeStuckFinalizeRunSteps: { run: vi.fn(() => ({ changes: 1 })) },
    } as unknown as Stmts;
  }

  it('reaps a stalled run: flips row + steps, broadcasts terminal pair, snapshots for retrigger', async () => {
    const c = candidate({ queued_steps: 1, running_steps: 0, last_activity_ms: NOW - 9 * MIN });
    const stmts = fakeStmts([c]);
    const broadcast = vi.fn();
    const abort = vi.fn();
    const onReaped = vi.fn();

    const res = await runStuckRunReaper({
      stmts,
      broadcast,
      abort,
      onReaped,
      nowMs: () => NOW,
      isLive: NEVER_LIVE,
      logger: { warn: vi.fn(), log: vi.fn() },
    });

    expect(res.reaped).toEqual([{ runId: 'run-1', reason: 'orphaned', sessionId: 'sess-1' }]);
    expect(stmts.failRuntimeStuckFinalizeRun.run).toHaveBeenCalledWith({
      id: 'run-1',
      cutoff: NOW - CONFIG.orphanIdleMs,
      failure_reason: failureReasonForStuckRun('orphaned'),
    });
    expect(stmts.failRuntimeStuckFinalizeRunSteps.run).toHaveBeenCalledWith('run-1');
    expect(abort).toHaveBeenCalledWith('run-1');

    const types = broadcast.mock.calls.map((c2) => (c2[0] as { type: string }).type);
    expect(types).toEqual(['finalize_run_phase_changed', 'finalize_run_completed']);
    for (const call of broadcast.mock.calls) {
      const evt = call[0] as Record<string, unknown>;
      expect(evt.run_id).toBe('run-1');
      expect(evt.session_id).toBe('sess-1');
      expect(evt.status).toBe('infra_error');
    }

    expect(onReaped).toHaveBeenCalledTimes(1);
    expect(onReaped.mock.calls[0][0]).toEqual([
      {
        runId: 'run-1',
        sessionId: 'sess-1',
        cardId: 'card-1',
        projectId: 'agent-hub',
        headSha: 'abc123',
      },
    ]);
  });

  it('leaves a healthy (actively executing) run untouched — no flip, no broadcast, no retrigger', async () => {
    const c = candidate({ running_steps: 1, queued_steps: 2, last_activity_ms: NOW - 60 * MIN });
    const stmts = fakeStmts([c]);
    const broadcast = vi.fn();
    const onReaped = vi.fn();

    const res = await runStuckRunReaper({
      stmts,
      broadcast,
      onReaped,
      nowMs: () => NOW,
      isLive: NEVER_LIVE,
      logger: { warn: vi.fn(), log: vi.fn() },
    });

    expect(res.reaped).toEqual([]);
    expect(stmts.failRuntimeStuckFinalizeRun.run).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(onReaped).not.toHaveBeenCalled();
  });

  it('skips a run that went terminal between select and reap (lost race → 0 changes)', async () => {
    const c = candidate({ queued_steps: 1, running_steps: 0, last_activity_ms: NOW - 9 * MIN });
    const stmts = fakeStmts([c], /* failChanges */ 0);
    const broadcast = vi.fn();
    const onReaped = vi.fn();

    const res = await runStuckRunReaper({
      stmts,
      broadcast,
      onReaped,
      nowMs: () => NOW,
      isLive: NEVER_LIVE,
      logger: { warn: vi.fn(), log: vi.fn() },
    });

    expect(res.reaped).toEqual([]);
    expect(stmts.failRuntimeStuckFinalizeRun.run).toHaveBeenCalledWith({
      id: 'run-1',
      cutoff: NOW - CONFIG.orphanIdleMs,
      failure_reason: failureReasonForStuckRun('orphaned'),
    });
    // Lost the race → must NOT sweep steps, broadcast, or retrigger.
    expect(stmts.failRuntimeStuckFinalizeRunSteps.run).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(onReaped).not.toHaveBeenCalled();
  });

  it('does not call onReaped when nothing was reaped', async () => {
    const stmts = fakeStmts([]);
    const onReaped = vi.fn();
    await runStuckRunReaper({
      stmts,
      broadcast: vi.fn(),
      onReaped,
      nowMs: () => NOW,
      isLive: NEVER_LIVE,
      logger: { warn: vi.fn(), log: vi.fn() },
    });
    expect(onReaped).not.toHaveBeenCalled();
  });
});

/**
 * Real-SQLite coverage for the candidate query itself. The classifier guard
 * above is belt; this is suspenders at the SQL layer the reviewer flagged: a
 * pre-start run (`queued`/`rebasing`/…) must never even be RETURNED as a
 * candidate, so the once-a-minute cron cannot fail a pending run on the happy
 * path. SQL mirrors `selectRuntimeStuckFinalizeRunCandidates` in db.ts (same
 * inline-duplication convention as boot-recovery.test.ts).
 */
describe('selectRuntimeStuckFinalizeRunCandidates (SQL)', () => {
  // Built from the SAME fragment db.ts uses, so the clock cannot drift out from
  // under these tests (it did once — see stuck-run-clock-sql.ts).
  const CANDIDATE_SQL = `
    SELECT r.id, r.status, r.session_id, r.card_id, r.project_id, r.head_sha, r.started_at,
           ${stuckRunProgressClockSql('r')} AS last_activity_ms,
           (SELECT COUNT(*) FROM finalize_run_steps s WHERE s.run_id = r.id AND s.state = 'queued')  AS queued_steps,
           (SELECT COUNT(*) FROM finalize_run_steps s WHERE s.run_id = r.id AND s.state = 'running') AS running_steps
      FROM finalize_runs r
     WHERE r.status = 'running'`;

  function setup() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE finalize_runs (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, session_id TEXT, card_id TEXT,
        project_id TEXT, head_sha TEXT, started_at INTEGER, ended_at INTEGER,
        phase_changed_at INTEGER
      );
      CREATE TABLE finalize_run_steps (
        run_id TEXT, step_index INTEGER, state TEXT NOT NULL, started_at INTEGER, ended_at INTEGER
      );
      CREATE TABLE finalize_run_jobs (
        run_id TEXT, job_id TEXT, matrix_key TEXT, state TEXT NOT NULL,
        started_at INTEGER, ended_at INTEGER
      );
    `);
    const insRun = db.prepare(
      `INSERT INTO finalize_runs (id, status, session_id, card_id, project_id, head_sha, started_at, phase_changed_at)
       VALUES (@id, @status, @session_id, @card_id, @project_id, @head_sha, @started_at, @phase_changed_at)`,
    );
    const insStep = db.prepare(
      `INSERT INTO finalize_run_steps (run_id, step_index, state, started_at, ended_at)
       VALUES (@run_id, @step_index, @state, @started_at, @ended_at)`,
    );
    const insJob = db.prepare(
      `INSERT INTO finalize_run_jobs (run_id, job_id, matrix_key, state, started_at, ended_at)
       VALUES (@run_id, @job_id, @matrix_key, @state, @started_at, @ended_at)`,
    );
    return { db, insRun, insStep, insJob };
  }

  it('returns the stalled running run but NOT pre-start (queued/rebasing/reviewing) runs', () => {
    const { db, insRun, insStep } = setup();
    const base = {
      session_id: 's',
      card_id: 'c',
      project_id: 'agent-hub',
      head_sha: 'h',
      started_at: NOW - 30 * MIN,
      phase_changed_at: null,
    };
    // Stalled running run: 2 passed + 1 queued, nothing running, idle ~10min.
    insRun.run({ id: 'running-stalled', status: 'running', ...base });
    insStep.run({
      run_id: 'running-stalled',
      step_index: 1,
      state: 'passed',
      started_at: NOW - 15 * MIN,
      ended_at: NOW - 14 * MIN,
    });
    insStep.run({
      run_id: 'running-stalled',
      step_index: 2,
      state: 'passed',
      started_at: NOW - 14 * MIN,
      ended_at: NOW - 10 * MIN,
    });
    insStep.run({
      run_id: 'running-stalled',
      step_index: 3,
      state: 'queued',
      started_at: null,
      ended_at: null,
    });
    // Pre-start runs sharing the orphaned SHAPE (queued steps, nothing running),
    // idle well past both thresholds — these MUST be excluded by the query.
    for (const status of ['queued', 'rebasing', 'reviewing', 'dispatching']) {
      insRun.run({ id: `pre-${status}`, status, ...base });
      insStep.run({
        run_id: `pre-${status}`,
        step_index: 1,
        state: 'queued',
        started_at: null,
        ended_at: null,
      });
      insStep.run({
        run_id: `pre-${status}`,
        step_index: 2,
        state: 'queued',
        started_at: null,
        ended_at: null,
      });
    }

    const rows = db.prepare(CANDIDATE_SQL).all() as RuntimeStuckRunCandidate[];
    expect(rows.map((r) => r.id)).toEqual(['running-stalled']);

    // End-to-end: the one returned candidate classifies as a reapable orphan.
    const [c] = rows;
    expect(c.queued_steps).toBe(1);
    expect(c.running_steps).toBe(0);
    expect(classifyRuntimeStuckRun(c, { nowMs: NOW, isLive: NEVER_LIVE, config: CONFIG })).toBe(
      'orphaned',
    );
    db.close();
  });

  /**
   * Production run f773c012 (surveytracker, 2026-07-27). The run spent 33
   * minutes in rebase → review → fix rounds, the reviewer approved it at round
   * 4, the orchestrator flipped to the tasks phase and dispatched 13 jobs — and
   * the reaper killed it 4 SECONDS later, because the progress clock was still
   * floored at the run's INSERT 33 minutes earlier. The session timeline ended
   * on "Review · round 4 · approved" with nothing after it: the user-visible
   * report was "this finalize stopped for seemingly no reason".
   *
   * A run only reaches status='running' AT the tasks phase, so this is not a
   * narrow race — every run whose review phase outlasts the idle threshold hit
   * it on the reaper's first tick.
   */
  it('does NOT reap a run that just entered the tasks phase after a long review', () => {
    const { db, insRun, insStep, insJob } = setup();
    insRun.run({
      id: 'long-review',
      status: 'running',
      session_id: 's',
      card_id: 'c',
      project_id: 'surveytracker',
      head_sha: 'h',
      // Row inserted 33 min ago; every minute since went to rebase/review/fix,
      // none of which writes a step row.
      started_at: NOW - 33 * MIN,
      // The orchestrator flipped to phase=tasks 4 seconds ago — proof of life.
      phase_changed_at: NOW - 4_000,
    });
    // Steps are dispatched `queued`; they only flip to `running` once a runner
    // picks them up, so this window has the exact reapable shape.
    for (let i = 1; i <= 13; i++) {
      insStep.run({ run_id: 'long-review', step_index: i, state: 'queued', ...NO_TIMES });
    }
    for (let i = 1; i <= 13; i++) {
      insJob.run({
        run_id: 'long-review',
        job_id: `job-${i}`,
        matrix_key: '',
        state: 'running',
        started_at: NOW - 4_000,
        ended_at: null,
      });
    }

    const [c] = db.prepare(CANDIDATE_SQL).all() as RuntimeStuckRunCandidate[];
    expect(c.queued_steps).toBe(13);
    expect(c.running_steps).toBe(0);
    // The clock tracks the phase write + job dispatch, NOT the 33-min-old INSERT.
    expect(c.last_activity_ms).toBe(NOW - 4_000);
    // Healthy under both reasons — including `hung`, which is what actually
    // fired in production (the orchestrator was very much alive).
    expect(
      classifyRuntimeStuckRun(c, { nowMs: NOW, isLive: NEVER_LIVE, config: CONFIG }),
    ).toBeNull();
    expect(
      classifyRuntimeStuckRun(c, { nowMs: NOW, isLive: ALWAYS_LIVE, config: CONFIG }),
    ).toBeNull();
    db.close();
  });

  it('still reaps once the tasks phase itself goes idle past the threshold', () => {
    // The counterpart: same shape, but nothing has happened since the phase
    // write. Re-anchoring the clock must not disarm the reaper, only move its
    // origin to the last real progress.
    const { db, insRun, insStep, insJob } = setup();
    insRun.run({
      id: 'stalled-tasks',
      status: 'running',
      session_id: 's',
      card_id: 'c',
      project_id: 'surveytracker',
      head_sha: 'h',
      started_at: NOW - 60 * MIN,
      phase_changed_at: NOW - 12 * MIN,
    });
    insStep.run({ run_id: 'stalled-tasks', step_index: 1, state: 'queued', ...NO_TIMES });
    insJob.run({
      run_id: 'stalled-tasks',
      job_id: 'job-1',
      matrix_key: '',
      state: 'queued',
      started_at: null,
      ended_at: null,
    });

    const [c] = db.prepare(CANDIDATE_SQL).all() as RuntimeStuckRunCandidate[];
    expect(c.last_activity_ms).toBe(NOW - 12 * MIN);
    expect(classifyRuntimeStuckRun(c, { nowMs: NOW, isLive: NEVER_LIVE, config: CONFIG })).toBe(
      'orphaned',
    );
    db.close();
  });
});

/**
 * Real-SQLite coverage for the ATOMIC reap-guard. The select is a snapshot; the
 * UPDATE must re-validate the reapable shape against current rows so a run that
 * made progress between select and reap (the reviewer's TOCTOU) is never failed.
 * SQL mirrors `failRuntimeStuckFinalizeRun` in db.ts — keep in sync.
 */
describe('failRuntimeStuckFinalizeRun (atomic reap-guard, SQL)', () => {
  const FAIL_SQL = `
    UPDATE finalize_runs
       SET status = 'infra_error',
           failure_reason = @failure_reason,
           phase = NULL,
           ended_at = COALESCE(ended_at, unixepoch() * 1000)
     WHERE id = @id
       AND status = 'running'
       AND NOT EXISTS (
             SELECT 1 FROM finalize_run_steps s
              WHERE s.run_id = finalize_runs.id AND s.state = 'running'
           )
       AND EXISTS (
             SELECT 1 FROM finalize_run_steps s
              WHERE s.run_id = finalize_runs.id AND s.state = 'queued'
           )
       AND ${stuckRunProgressClockSql('finalize_runs')} <= @cutoff`;

  const REASON = failureReasonForStuckRun('orphaned');

  // The reaper passes cutoff = nowMs − idle threshold; last_activity ≤ cutoff
  // means "still idle past the threshold". Our stalled run last moved 10min ago.
  const CUTOFF = NOW - CONFIG.orphanIdleMs; // 8 min before NOW

  function setup() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE finalize_runs (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, phase TEXT, failure_reason TEXT,
        started_at INTEGER, ended_at INTEGER, phase_changed_at INTEGER
      );
      CREATE TABLE finalize_run_steps (
        run_id TEXT, step_index INTEGER, state TEXT NOT NULL, started_at INTEGER, ended_at INTEGER
      );
      CREATE TABLE finalize_run_jobs (
        run_id TEXT, job_id TEXT, matrix_key TEXT, state TEXT NOT NULL,
        started_at INTEGER, ended_at INTEGER
      );
    `);
    // Baseline reapable run: status=running, 1 passed (ended 10min ago) + 1
    // queued, nothing running → idle 10min, past the 8min cutoff.
    db.prepare(`INSERT INTO finalize_runs (id, status, started_at) VALUES ('r', 'running', ?)`).run(
      NOW - 30 * MIN,
    );
    const insStep = db.prepare(
      `INSERT INTO finalize_run_steps (run_id, step_index, state, started_at, ended_at)
       VALUES ('r', @i, @state, @started_at, @ended_at)`,
    );
    insStep.run({ i: 1, state: 'passed', started_at: NOW - 14 * MIN, ended_at: NOW - 10 * MIN });
    insStep.run({ i: 2, state: 'queued', started_at: null, ended_at: null });
    const fail = db.prepare(FAIL_SQL);
    return { db, insStep, fail };
  }

  it('reaps the genuinely-stalled run (baseline)', () => {
    const { db, fail } = setup();
    expect(fail.run({ id: 'r', cutoff: CUTOFF, failure_reason: REASON }).changes).toBe(1);
    expect(db.prepare(`SELECT status FROM finalize_runs WHERE id='r'`).get()).toEqual({
      status: 'infra_error',
    });
    db.close();
  });

  it('does NOT reap when a queued step started running after the snapshot (the TOCTOU)', () => {
    const { db, insStep, fail } = setup();
    // The exact race: the select saw running_steps=0; now a step is running.
    insStep.run({ i: 3, state: 'running', started_at: NOW - 30_000, ended_at: null });
    expect(fail.run({ id: 'r', cutoff: CUTOFF, failure_reason: REASON }).changes).toBe(0);
    expect(db.prepare(`SELECT status FROM finalize_runs WHERE id='r'`).get()).toEqual({
      status: 'running',
    });
    db.close();
  });

  it('does NOT reap when a step finished after the snapshot (activity bumped past cutoff)', () => {
    const { db, insStep, fail } = setup();
    // A step completed just now → last activity = NOW, no longer idle past cutoff.
    insStep.run({ i: 3, state: 'passed', started_at: NOW - 60_000, ended_at: NOW });
    expect(fail.run({ id: 'r', cutoff: CUTOFF, failure_reason: REASON }).changes).toBe(0);
    db.close();
  });

  it('does NOT reap when the orchestrator wrote a phase after the snapshot', () => {
    // The production miss: proof-of-life between phases is real progress, and
    // the guard must honour it exactly as it honours a step transition.
    const { db, fail } = setup();
    db.prepare(`UPDATE finalize_runs SET phase_changed_at=? WHERE id='r'`).run(NOW);
    expect(fail.run({ id: 'r', cutoff: CUTOFF, failure_reason: REASON }).changes).toBe(0);
    expect(db.prepare(`SELECT status FROM finalize_runs WHERE id='r'`).get()).toEqual({
      status: 'running',
    });
    db.close();
  });

  it('does NOT reap when a runner claimed a job after the snapshot', () => {
    // A job goes `running` before its first step does, so job activity has to
    // count — otherwise the runner-boot window looks identical to a stall.
    const { db, fail } = setup();
    db.prepare(
      `INSERT INTO finalize_run_jobs (run_id, job_id, matrix_key, state, started_at, ended_at)
       VALUES ('r', 'job-1', '', 'running', ?, NULL)`,
    ).run(NOW);
    expect(fail.run({ id: 'r', cutoff: CUTOFF, failure_reason: REASON }).changes).toBe(0);
    db.close();
  });

  it('does NOT reap when the run advanced off running (e.g. to pushing)', () => {
    const { db, fail } = setup();
    db.prepare(`UPDATE finalize_runs SET status='pushing' WHERE id='r'`).run();
    expect(fail.run({ id: 'r', cutoff: CUTOFF, failure_reason: REASON }).changes).toBe(0);
    db.close();
  });

  it('does NOT reap when the queued work drained (all steps completed)', () => {
    const { db, fail } = setup();
    db.prepare(
      `UPDATE finalize_run_steps SET state='passed' WHERE run_id='r' AND state='queued'`,
    ).run();
    expect(fail.run({ id: 'r', cutoff: CUTOFF, failure_reason: REASON }).changes).toBe(0);
    db.close();
  });

  it('records a reason-accurate failure_reason that keeps the crash-loop prefix', () => {
    // The row used to hardcode "no live orchestrator" for BOTH reasons, so a
    // hung-but-registered run (production f773c012) reported the wrong cause.
    const { db, fail } = setup();
    const hung = failureReasonForStuckRun('hung');
    expect(hung).not.toBe(failureReasonForStuckRun('orphaned'));
    for (const reason of ['orphaned', 'hung'] as const) {
      // countInterruptedFinalizeRunsForSessionHead matches on this prefix.
      expect(failureReasonForStuckRun(reason)).toMatch(/^Finalize run interrupted/);
    }
    fail.run({ id: 'r', cutoff: CUTOFF, failure_reason: hung });
    expect(db.prepare(`SELECT failure_reason FROM finalize_runs WHERE id='r'`).get()).toEqual({
      failure_reason: hung,
    });
    db.close();
  });
});
