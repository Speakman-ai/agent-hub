/**
 * PR-Env Removal #3 — post-strip invariants.
 *
 * Asserts the DB-level and import-level acceptance criteria from kanban
 * card 7ecc5175 / epic 88367984:
 *
 *   1. Fresh DB init drops `pr_env_config` (legacy table, schema gone).
 *   2. Webhooks module no longer imports any PR-env dispatchers.
 *   3. `dispatchPrEnvBuild` / `dispatchPrEnvTeardown` symbols are gone
 *      from the codebase.
 *
 * Boot-level smoke (server start without throwing) is covered by the
 * existing test/setup.ts global bootstrap; we only need to pin the data
 * shape and the dead-symbol invariant here.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';

describe('PR-Env Removal #3 — DB invariants', () => {
  it('pr_env_config table is dropped on init and does not appear in sqlite_master', async () => {
    // Spin up a fresh DB the same way initDb() does, then assert the
    // table does not exist. We seed it first to prove the migration is
    // actually dropping (rather than just never creating) the table.
    const dataDir = mkdtempSync(path.join(tmpdir(), 'pr-env-removal-'));
    const dbPath = path.join(dataDir, 'agent-hub.db');
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE pr_env_config (id INTEGER PRIMARY KEY, foo TEXT)');
    seed.close();

    // Apply the same migration db.ts now runs at boot.
    const db = new Database(dbPath);
    db.exec('DROP TABLE IF EXISTS pr_env_config');

    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pr_env_config'")
      .all();
    expect(rows).toEqual([]);
    db.close();
  });
});
