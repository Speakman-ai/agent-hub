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
      id TEXT PRIMARY KEY, status TEXT NOT NULL, phase TEXT, failure_reason TEXT, ended_at INTEGER
    );
    CREATE TABLE finalize_run_steps (
      run_id TEXT, step_index INTEGER, state TEXT NOT NULL, ended_at INTEGER
    );
  `);
  const stmts = {
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
  } as unknown as Stmts;
  return { db, stmts };
}

describe('failStuckFinalizeRunsOnBoot', () => {
  it('fails in-flight runs (infra_error) + skips their unfinished steps, leaving terminal ones alone', () => {
    const { db, stmts } = setup();
    db.prepare("INSERT INTO finalize_runs (id, status, phase) VALUES ('r-run','running','tasks')").run();
    db.prepare(
      "INSERT INTO finalize_runs (id, status, phase) VALUES ('r-disp','dispatching','dispatching')",
    ).run();
    db.prepare(
      "INSERT INTO finalize_runs (id, status, phase, ended_at) VALUES ('r-done','pushed',NULL,123)",
    ).run();
    db.prepare("INSERT INTO finalize_run_steps (run_id, step_index, state) VALUES ('r-run',0,'running')").run();
    db.prepare("INSERT INTO finalize_run_steps (run_id, step_index, state) VALUES ('r-run',1,'queued')").run();
    db.prepare("INSERT INTO finalize_run_steps (run_id, step_index, state) VALUES ('r-run',2,'passed')").run();

    failStuckFinalizeRunsOnBoot(stmts);

    const run = db.prepare("SELECT * FROM finalize_runs WHERE id='r-run'").get() as Record<string, unknown>;
    expect(run.status).toBe('infra_error');
    expect(String(run.failure_reason)).toMatch(/interrupted/i);
    expect(run.phase).toBeNull();
    expect(Number(run.ended_at)).toBeGreaterThan(0);

    // The stalled "dispatching" run is also orphaned on restart.
    const disp = db.prepare("SELECT status FROM finalize_runs WHERE id='r-disp'").get() as { status: string };
    expect(disp.status).toBe('infra_error');

    // A terminal run is never touched (status + ended_at preserved).
    const done = db.prepare("SELECT status, ended_at FROM finalize_runs WHERE id='r-done'").get() as {
      status: string;
      ended_at: number;
    };
    expect(done.status).toBe('pushed');
    expect(done.ended_at).toBe(123);

    // running/queued steps → skipped; an already-passed step is left as-is.
    const steps = db
      .prepare("SELECT step_index, state FROM finalize_run_steps WHERE run_id='r-run' ORDER BY step_index")
      .all() as Array<{ step_index: number; state: string }>;
    expect(steps.map((s) => s.state)).toEqual(['skipped', 'skipped', 'passed']);
  });

  it('is a no-op (no throw) when there are no in-flight runs', () => {
    const { db, stmts } = setup();
    db.prepare("INSERT INTO finalize_runs (id, status) VALUES ('r-done','cancelled')").run();
    expect(() => failStuckFinalizeRunsOnBoot(stmts)).not.toThrow();
    const r = db.prepare("SELECT status FROM finalize_runs WHERE id='r-done'").get() as { status: string };
    expect(r.status).toBe('cancelled');
  });
});
