/**
 * Threads removal — schema-convergence migration test.
 *
 * Threads were replaced by Agent Hub Chat. `initDb` now drops `threads` and
 * `thread_entries` unconditionally instead of creating them, so an install
 * that still has thread history must converge on the same schema as a fresh
 * install, with no orphaned `idx_thread*` indexes left behind.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initDb, getDb } from './db.js';

function schemaSnapshot(db: InstanceType<typeof Database>): string[] {
  return (
    db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all() as Array<{ type: string; name: string; sql: string | null }>
  ).map((r) => `${r.type}:${r.name}:${(r.sql ?? '').replace(/\s+/g, ' ').trim()}`);
}

/** The threads schema as it last shipped, with a row in each table. */
function seedThreadsSchema(dbPath: string): void {
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('cron', 'heartbeat')),
      source_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_threads_project ON threads(project_id);
    CREATE INDEX idx_threads_type ON threads(project_id, type);
    CREATE INDEX idx_threads_source ON threads(project_id, source_id);
    CREATE TABLE thread_entries (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      author_user_id TEXT,
      author_agent_id TEXT,
      role TEXT NOT NULL DEFAULT 'system' CHECK(role IN ('system','user','assistant')),
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_thread_entries_thread ON thread_entries(thread_id);
    INSERT INTO threads (id, project_id, name, type, source_id) VALUES ('t1', 'p', 'Nightly', 'cron', '1');
    INSERT INTO thread_entries (id, thread_id, content) VALUES ('e1', 't1', 'run output');
  `);
  seed.close();
}

let freshSchema: string[];
let upgradedSchema: string[];

beforeAll(() => {
  const freshDir = mkdtempSync(path.join(tmpdir(), 'ah-threads-drop-fresh-'));
  initDb(freshDir);
  freshSchema = schemaSnapshot(getDb());

  const legacyDir = mkdtempSync(path.join(tmpdir(), 'ah-threads-drop-legacy-'));
  seedThreadsSchema(path.join(legacyDir, 'agent-hub.db'));
  initDb(legacyDir);
  upgradedSchema = schemaSnapshot(getDb());
});

describe('threads table removal', () => {
  it('drops threads and thread_entries on upgrade', () => {
    const tables = upgradedSchema.filter((s) => s.startsWith('table:')).map((s) => s.split(':')[1]);
    expect(tables).not.toContain('threads');
    expect(tables).not.toContain('thread_entries');
  });

  it('does not create the tables on a fresh install', () => {
    const tables = freshSchema.filter((s) => s.startsWith('table:')).map((s) => s.split(':')[1]);
    expect(tables).not.toContain('threads');
    expect(tables).not.toContain('thread_entries');
  });

  it('leaves no orphaned thread indexes behind', () => {
    const threadIndexes = (rows: string[]): string[] =>
      rows.filter((s) => /^index:idx_thread(s|_entries)_/.test(s));
    expect(threadIndexes(upgradedSchema)).toEqual([]);
    expect(threadIndexes(freshSchema)).toEqual([]);
  });

  it('a fresh DB and a threads-era DB converge on the same schema', () => {
    expect(upgradedSchema).toEqual(freshSchema);
  });
});
