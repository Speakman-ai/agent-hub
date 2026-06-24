import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Stmts } from './../types.js';
import { failStuckFinalizeRunsOnBoot } from './boot-recovery.js';

const TERM =
  "('pushed','failed','timed_out','infra_error','cancelled','stalled_no_response','ready_to_push')";

// Minimal in-memory tables exposing only the columns the boot sweep touches.
function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE finalize_runs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, phase TEXT, failure_reason TEXT,
      session_id TEXT, card_id TEXT, project_id TEXT, head_sha TEXT,
      started_at INTEGER, ended_at INTEGER,
      failed_step_index INTEGER, failed_step_name TEXT, failed_step_exit_code INTEGER
    );
    CREATE TABLE finalize_run_steps (
      run_id TEXT, step_index INTEGER, name TEXT, state TEXT NOT NULL,
      exit_code INTEGER, ended_at INTEGER
    );
  `);
  const stmts = {
    selectStuckActiveFinalizeRunsOnBoot: db.prepare(
      `SELECT id, session_id, card_id, project_id, head_sha
         FROM finalize_runs
        WHERE status NOT IN ${TERM}
        ORDER BY started_at DESC, id DESC`,
    ),
    failStuckActiveFinalizeRunsOnBoot: db.prepare(
      `UPDATE finalize_runs
         SET status='infra_error',
             failure_reason='Finalize run interrupted (server restart or crash)',
             phase=NULL,
             ended_at=COALESCE(ended_at, unixepoch() * 1000)
       WHERE status NOT IN ${TERM}`,
    ),
    failStuckActiveFinalizeRunStepsOnBoot: db.prepare(
      `UPDATE finalize_run_steps
         SET state='skipped', ended_at=COALESCE(ended_at, unixepoch() * 1000)
       WHERE state IN ('queued','running')`,
    ),
    backfillFinalizeRunFailedStepsOnBoot: db.prepare(
      `UPDATE finalize_runs
          SET failed_step_index = (
                SELECT s.step_index FROM finalize_run_steps s
                 WHERE s.run_id = finalize_runs.id AND s.state = 'failed'
                 ORDER BY s.step_index ASC LIMIT 1
              ),
              failed_step_name = (
                SELECT s.name FROM finalize_run_steps s
                 WHERE s.run_id = finalize_runs.id AND s.state = 'failed'
                 ORDER BY s.step_index ASC LIMIT 1
              ),
              failed_step_exit_code = (
                SELECT s.exit_code FROM finalize_run_steps s
                 WHERE s.run_id = finalize_runs.id AND s.state = 'failed'
                 ORDER BY s.step_index ASC LIMIT 1
              )
        WHERE status IN ('failed', 'timed_out')
          AND failed_step_index IS NULL
          AND EXISTS (
                SELECT 1 FROM finalize_run_steps s
                 WHERE s.run_id = finalize_runs.id AND s.state = 'failed'
              )`,
    ),
  } as unknown as Stmts;
  return { db, stmts };
}

describe('failStuckFinalizeRunsOnBoot', () => {
  it('fails in-flight runs (infra_error) + skips their unfinished steps, leaving terminal ones alone', () => {
    const { db, stmts } = setup();
    db.prepare(
      `INSERT INTO finalize_runs (id, status, phase, session_id, card_id, project_id, head_sha, started_at)
       VALUES ('r-run','running','tasks','s1','c1','p1','sha1',200)`,
    ).run();
    db.prepare(
      `INSERT INTO finalize_runs (id, status, phase, session_id, card_id, project_id, head_sha, started_at)
       VALUES ('r-disp','dispatching','dispatching','s2','c2','p1','sha2',100)`,
    ).run();
    db.prepare(
      "INSERT INTO finalize_runs (id, status, phase, ended_at) VALUES ('r-done','pushed',NULL,123)",
    ).run();
    db.prepare(
      "INSERT INTO finalize_run_steps (run_id, step_index, state) VALUES ('r-run',0,'running')",
    ).run();
    db.prepare(
      "INSERT INTO finalize_run_steps (run_id, step_index, state) VALUES ('r-run',1,'queued')",
    ).run();
    db.prepare(
      "INSERT INTO finalize_run_steps (run_id, step_index, state) VALUES ('r-run',2,'passed')",
    ).run();

    const interrupted = failStuckFinalizeRunsOnBoot(stmts);

    // Snapshot is captured BEFORE the sweep, most-recent first, and carries the
    // identifiers needed to re-trigger a fresh run per session. The terminal
    // 'pushed' run is excluded.
    expect(interrupted).toEqual([
      { runId: 'r-run', sessionId: 's1', cardId: 'c1', projectId: 'p1', headSha: 'sha1' },
      { runId: 'r-disp', sessionId: 's2', cardId: 'c2', projectId: 'p1', headSha: 'sha2' },
    ]);

    const run = db.prepare("SELECT * FROM finalize_runs WHERE id='r-run'").get() as Record<
      string,
      unknown
    >;
    expect(run.status).toBe('infra_error');
    expect(String(run.failure_reason)).toMatch(/interrupted/i);
    expect(run.phase).toBeNull();
    expect(Number(run.ended_at)).toBeGreaterThan(0);

    // The stalled "dispatching" run is also orphaned on restart.
    const disp = db.prepare("SELECT status FROM finalize_runs WHERE id='r-disp'").get() as {
      status: string;
    };
    expect(disp.status).toBe('infra_error');

    // A terminal run is never touched (status + ended_at preserved).
    const done = db
      .prepare("SELECT status, ended_at FROM finalize_runs WHERE id='r-done'")
      .get() as {
      status: string;
      ended_at: number;
    };
    expect(done.status).toBe('pushed');
    expect(done.ended_at).toBe(123);

    // running/queued steps → skipped; an already-passed step is left as-is.
    const steps = db
      .prepare(
        "SELECT step_index, state FROM finalize_run_steps WHERE run_id='r-run' ORDER BY step_index",
      )
      .all() as Array<{ step_index: number; state: string }>;
    expect(steps.map((s) => s.state)).toEqual(['skipped', 'skipped', 'passed']);
  });

  it('is a no-op (no throw, empty snapshot) when there are no in-flight runs', () => {
    const { db, stmts } = setup();
    db.prepare("INSERT INTO finalize_runs (id, status) VALUES ('r-done','cancelled')").run();
    let interrupted: ReturnType<typeof failStuckFinalizeRunsOnBoot> = [];
    expect(() => {
      interrupted = failStuckFinalizeRunsOnBoot(stmts);
    }).not.toThrow();
    expect(interrupted).toEqual([]);
    const r = db.prepare("SELECT status FROM finalize_runs WHERE id='r-done'").get() as {
      status: string;
    };
    expect(r.status).toBe('cancelled');
  });

  it('excludes interrupted runs missing a session/card from the retrigger snapshot', () => {
    const { db, stmts } = setup();
    // In-flight but no session_id → swept, but NOT a retrigger candidate.
    db.prepare(
      "INSERT INTO finalize_runs (id, status, started_at) VALUES ('r-orphan','running',10)",
    ).run();
    const interrupted = failStuckFinalizeRunsOnBoot(stmts);
    expect(interrupted).toEqual([]);
    const r = db.prepare("SELECT status FROM finalize_runs WHERE id='r-orphan'").get() as {
      status: string;
    };
    expect(r.status).toBe('infra_error');
  });

  it('backfills failed_step_* for an already-terminal failed run that lost its summary', () => {
    // Regression: a v2 matrix shard marked the run `failed`/`step_failed` on the
    // first shard failure (premature run-terminal write) but never recorded WHICH
    // step failed, and the Hub then crashed before the in-process reconcile ran.
    // The run is already terminal, so the run/step SWEEPS skip it — only the
    // failed-step backfill repairs the "can't name the failing step" gap.
    const { db, stmts } = setup();
    db.prepare(
      `INSERT INTO finalize_runs (id, status, failure_reason, ended_at)
       VALUES ('r-term','failed','step_failed',500)`,
    ).run();
    db.prepare(
      "INSERT INTO finalize_run_steps (run_id, step_index, name, state, exit_code) VALUES ('r-term',8,'server 1/3','failed',1)",
    ).run();
    db.prepare(
      "INSERT INTO finalize_run_steps (run_id, step_index, name, state, exit_code) VALUES ('r-term',9,'server 2/3','passed',0)",
    ).run();

    failStuckFinalizeRunsOnBoot(stmts);

    const run = db.prepare("SELECT * FROM finalize_runs WHERE id='r-term'").get() as Record<
      string,
      unknown
    >;
    // Terminal status/ended_at untouched; only the summary is filled in.
    expect(run.status).toBe('failed');
    expect(run.ended_at).toBe(500);
    expect(run.failed_step_index).toBe(8);
    expect(run.failed_step_name).toBe('server 1/3');
    expect(run.failed_step_exit_code).toBe(1);
  });

  it('does not overwrite a failed-step summary that is already recorded', () => {
    const { db, stmts } = setup();
    db.prepare(
      `INSERT INTO finalize_runs (id, status, failed_step_index, failed_step_name, failed_step_exit_code)
       VALUES ('r-keep','failed',3,'lint',2)`,
    ).run();
    db.prepare(
      "INSERT INTO finalize_run_steps (run_id, step_index, name, state, exit_code) VALUES ('r-keep',1,'build','failed',9)",
    ).run();

    failStuckFinalizeRunsOnBoot(stmts);

    const run = db.prepare("SELECT * FROM finalize_runs WHERE id='r-keep'").get() as Record<
      string,
      unknown
    >;
    // The `failed_step_index IS NULL` guard prevents clobbering the existing one.
    expect(run.failed_step_index).toBe(3);
    expect(run.failed_step_name).toBe('lint');
    expect(run.failed_step_exit_code).toBe(2);
  });
});
