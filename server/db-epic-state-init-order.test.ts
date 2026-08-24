import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initDb, getDb } from './db.js';

/**
 * Regression: initDb must not crash on a DB whose `kanban_epics` predates the
 * bootstrap `state` column.
 *
 * `installStatsCompletionTimestamps` runs the epic completion backfill/triggers,
 * which read `kanban_epics.state`. That read happens during schema setup, before
 * the additive schema reconciler can heal drift (the schema-reconcile.ts "known
 * limitation"). If the `state` column migration were ordered after the installer
 * — as it originally was — a pre-`state` DB threw `SqliteError: no such column:
 * state` at boot and the process crash-looped. The fix orders the `state` ALTER
 * ahead of the installer, so a legacy DB and a fresh DB both init cleanly.
 */

/**
 * Recreate the epic schema exactly as it shipped before `state` was added to the
 * bootstrap CREATE body: no `state` column and none of the later epic columns.
 */
function seedPreStateEpicSchema(dbPath: string): void {
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE kanban_epics (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      color TEXT NOT NULL DEFAULT '#6366F1',
      autonomous INTEGER NOT NULL DEFAULT 0,
      autonomous_interval INTEGER NOT NULL DEFAULT 5,
      autonomous_max_concurrent INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  seed.close();
}

function epicColumns(db: InstanceType<typeof Database>): string[] {
  return (db.prepare(`PRAGMA table_info(kanban_epics)`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

let upgradedCols: string[];

beforeAll(() => {
  const legacyDir = mkdtempSync(path.join(tmpdir(), 'ah-epic-state-order-'));
  seedPreStateEpicSchema(path.join(legacyDir, 'agent-hub.db'));
  // The bug: this call threw "no such column: state" before the fix.
  initDb(legacyDir);
  upgradedCols = epicColumns(getDb());
});

describe('kanban_epics.state migration ordering vs stats-completion backfill', () => {
  it('initDb completes on a pre-state epics DB and adds the state column', () => {
    expect(upgradedCols).toContain('state');
  });

  it('adds the epic completion timestamp column the backfill maintains', () => {
    expect(upgradedCols).toContain('completed_at');
  });
});
