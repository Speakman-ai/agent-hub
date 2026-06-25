import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  backfillPhaseAutonomousDefaults,
  PHASE_AUTONOMOUS_DEFAULTS_BACKFILL_MARKER,
} from './backfill-phase-autonomous-defaults.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE kanban_phases (
      id TEXT PRIMARY KEY,
      autonomous INTEGER NOT NULL DEFAULT 0,
      autonomous_running INTEGER NOT NULL DEFAULT 0,
      autonomous_send_it INTEGER NOT NULL DEFAULT 0
    )
  `);
  return db;
}

function insertPhase(
  db: Database.Database,
  id: string,
  autonomous: number,
  running: number,
  sendIt: number,
) {
  db.prepare(
    'INSERT INTO kanban_phases (id, autonomous, autonomous_running, autonomous_send_it) VALUES (?, ?, ?, ?)',
  ).run(id, autonomous, running, sendIt);
}

function readPhase(db: Database.Database, id: string) {
  return db.prepare('SELECT * FROM kanban_phases WHERE id = ?').get(id) as {
    autonomous: number;
    autonomous_running: number;
    autonomous_send_it: number;
  };
}

describe('backfillPhaseAutonomousDefaults', () => {
  let dataDir: string;
  let db: Database.Database;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'phase-backfill-'));
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('arms legacy 0/0 phases for auto-dispatch and Auto Merge, and writes the marker', () => {
    insertPhase(db, 'p1', 0, 0, 0);
    insertPhase(db, 'p2', 0, 0, 0);

    const r = backfillPhaseAutonomousDefaults({ db, dataDir });

    expect(r.ran).toBe(true);
    expect(r.armed).toBe(2);
    expect(r.autoMerge).toBe(2);
    expect(readPhase(db, 'p1')).toMatchObject({ autonomous: 1, autonomous_send_it: 1 });
    expect(readPhase(db, 'p2')).toMatchObject({ autonomous: 1, autonomous_send_it: 1 });
    expect(existsSync(r.markerPath)).toBe(true);
    expect(r.markerPath).toBe(path.join(dataDir, PHASE_AUTONOMOUS_DEFAULTS_BACKFILL_MARKER));
  });

  it('never touches autonomous_running (must not spontaneously start dispatch)', () => {
    insertPhase(db, 'p1', 0, 0, 0);

    backfillPhaseAutonomousDefaults({ db, dataDir });

    expect(readPhase(db, 'p1').autonomous_running).toBe(0);
  });

  it('is a no-op once the marker exists — respects a later user pause', () => {
    insertPhase(db, 'p1', 0, 0, 0);
    const first = backfillPhaseAutonomousDefaults({ db, dataDir });
    expect(first.ran).toBe(true);

    // The operator then pauses the phase (opt-out toggle → autonomous = 0).
    db.prepare('UPDATE kanban_phases SET autonomous = 0 WHERE id = ?').run('p1');

    // A second boot must NOT re-arm the paused phase.
    const second = backfillPhaseAutonomousDefaults({ db, dataDir });
    expect(second.ran).toBe(false);
    expect(second.armed).toBe(0);
    expect(readPhase(db, 'p1').autonomous).toBe(0);
  });

  it('treats a pre-existing marker as already-done without changing rows', () => {
    writeFileSync(
      path.join(dataDir, PHASE_AUTONOMOUS_DEFAULTS_BACKFILL_MARKER),
      'prior-run\n',
      'utf-8',
    );
    insertPhase(db, 'p1', 0, 0, 0);

    const r = backfillPhaseAutonomousDefaults({ db, dataDir });

    expect(r.ran).toBe(false);
    expect(readPhase(db, 'p1')).toMatchObject({ autonomous: 0, autonomous_send_it: 0 });
  });

  it('leaves already-armed / partially-set phases as-is and counts only the flips', () => {
    insertPhase(db, 'armed', 1, 1, 1); // fully set + running
    insertPhase(db, 'send-only', 0, 0, 1); // auto-merge already on, not armed

    const r = backfillPhaseAutonomousDefaults({ db, dataDir });

    expect(r.armed).toBe(1); // only 'send-only' flipped autonomous
    expect(r.autoMerge).toBe(0); // both already had autonomous_send_it = 1
    expect(readPhase(db, 'armed')).toMatchObject({ autonomous: 1, autonomous_running: 1 });
    expect(readPhase(db, 'send-only')).toMatchObject({ autonomous: 1, autonomous_send_it: 1 });
  });

  it('stamps the marker with the provided timestamp', () => {
    const r = backfillPhaseAutonomousDefaults({
      db,
      dataDir,
      nowIso: () => '2026-06-25T00:00:00.000Z',
    });
    expect(readFileSync(r.markerPath, 'utf-8')).toBe('2026-06-25T00:00:00.000Z\n');
  });
});
