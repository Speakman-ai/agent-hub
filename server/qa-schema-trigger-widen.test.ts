import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { getDb, initDb } from './db.js';
import { rebuildTableWithDdl } from './sqlite-widen-check.js';

describe('qa_plans.auto_rerun_trigger CHECK', () => {
  it('widens an install whose CHECK only admits deployment and merge, keeping plans and cases', () => {
    const sourceDir = mkdtempSync(path.join(tmpdir(), 'ah-qa-trigger-src-'));
    const legacyDir = mkdtempSync(path.join(tmpdir(), 'ah-qa-trigger-legacy-'));
    const legacyPath = path.join(legacyDir, 'agent-hub.db');
    initDb(sourceDir);
    getDb().exec(`VACUUM INTO '${legacyPath.replaceAll("'", "''")}'`);

    const legacy = new Database(legacyPath);
    const current = (
      legacy.prepare("SELECT sql FROM sqlite_master WHERE name = 'qa_plans'").get() as {
        sql: string;
      }
    ).sql;
    const narrowed = current.replace(
      /(auto_rerun_trigger\s+IN\s*\()[^)]*\)/,
      "$1'deployment', 'merge')",
    );
    expect(narrowed).not.toBe(current);
    rebuildTableWithDdl(legacy, 'qa_plans', narrowed);
    legacy.exec(`
      INSERT INTO qa_plans (id, project_id, title, target_url) VALUES ('p1', 'proj', 'T', 'u');
      INSERT INTO qa_cases (id, plan_id, title) VALUES ('c1', 'p1', 'Login');
    `);
    expect(() =>
      legacy.prepare("UPDATE qa_plans SET auto_rerun_trigger = 'fixes_merged'").run(),
    ).toThrow(/CHECK/);
    legacy.close();

    initDb(legacyDir);
    const db = getDb();
    db.prepare("UPDATE qa_plans SET auto_rerun_trigger = 'fixes_merged' WHERE id = 'p1'").run();
    expect(db.prepare("SELECT auto_rerun_trigger FROM qa_plans WHERE id = 'p1'").get()).toEqual({
      auto_rerun_trigger: 'fixes_merged',
    });
    expect(db.prepare("SELECT plan_id FROM qa_cases WHERE id = 'c1'").get()).toEqual({
      plan_id: 'p1',
    });
  });
});
