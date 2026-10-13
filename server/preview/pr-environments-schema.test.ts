import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  PR_ENVIRONMENTS_SCHEMA,
  migratePrEnvironmentsSourceCheck,
} from './pr-environments-schema.js';

const OLD_SCHEMA = PR_ENVIRONMENTS_SCHEMA.replace(
  "CHECK(source IN ('native', 'github'))",
  "CHECK(source IN ('native'))",
);

const insert = (db: Database.Database, id: string, source: string, pr: number) =>
  db
    .prepare(
      `INSERT INTO pr_environments (id, project_id, source, pr_number, head_sha, status, created_at, updated_at)
       VALUES (?, 'demo', ?, ?, 'abc', 'ready', 1, 1)`,
    )
    .run(id, source, pr);

describe('migratePrEnvironmentsSourceCheck', () => {
  it('lets an existing table take github rows and keeps what was there', () => {
    expect(OLD_SCHEMA).not.toBe(PR_ENVIRONMENTS_SCHEMA);
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);
    insert(db, 'n1', 'native', 7);
    expect(() => insert(db, 'g0', 'github', 8)).toThrow(/CHECK/);

    db.exec(PR_ENVIRONMENTS_SCHEMA); // what initDb runs first: a no-op here
    expect(migratePrEnvironmentsSourceCheck(db)).toBe(true);
    insert(db, 'g1', 'github', 8);
    const rows = db.prepare('SELECT id, source FROM pr_environments ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'g1', source: 'github' },
      { id: 'n1', source: 'native' },
    ]);
    // Key and index survive the rebuild.
    expect(() => insert(db, 'dup', 'native', 7)).toThrow(/UNIQUE/);
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pr_environments'",
      )
      .all()
      .map((r) => (r as { name: string }).name);
    expect(idx).toContain('idx_pr_environments_project_status');
    expect(() => insert(db, 'bad', 'gitlab', 9)).toThrow(/CHECK/);
  });

  it('is a no-op on a current table', () => {
    const db = new Database(':memory:');
    db.exec(PR_ENVIRONMENTS_SCHEMA);
    expect(migratePrEnvironmentsSourceCheck(db)).toBe(false);
    expect(migratePrEnvironmentsSourceCheck(db)).toBe(false);
  });
});
