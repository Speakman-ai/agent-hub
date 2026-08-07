import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  WORKTREE_PREVIEW_GROUPS_SCHEMA,
  DEV_SERVER_RUNTIME_KIND,
  dropComposePreviewColumns,
  deleteOrphanedNonDevServerPreviewRows,
  ensureHostScopedPreviewPortUniqueness,
} from './preview-schema.js';

/**
 * Recreate the pre-removal table: the base schema declared
 * `compose_project_name`, and the compose runtime's constructor added the
 * five companion columns via ALTER. A database written by the old server
 * looks exactly like this, so the migration has to cope with it.
 */
function openLegacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE worktree_preview_groups (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL,
      project_id      TEXT NOT NULL,
      status          TEXT NOT NULL CHECK(status IN ('starting','ready','failed')),
      started_at      TEXT NOT NULL DEFAULT (datetime('now')),
      last_active_at  TEXT NOT NULL DEFAULT (datetime('now')),
      compose_project_name TEXT,
      runtime TEXT,
      worktree_path TEXT,
      compose_file TEXT,
      entry_port INTEGER,
      override_file_path TEXT,
      host_project_directory TEXT
    );
    CREATE TABLE worktree_preview_processes (
      id              TEXT PRIMARY KEY,
      group_id        TEXT NOT NULL,
      name            TEXT NOT NULL,
      pid             INTEGER,
      port            INTEGER NOT NULL UNIQUE,
      url             TEXT NOT NULL,
      log_path        TEXT,
      status          TEXT NOT NULL CHECK(status IN ('pending','starting','ready','failed')),
      started_at      TEXT NOT NULL DEFAULT (datetime('now')),
      internal_port   INTEGER,
      is_primary      INTEGER NOT NULL DEFAULT 0,
      UNIQUE(group_id, name)
    );
  `);
  return db;
}

function insertGroup(
  db: Database.Database,
  id: string,
  runtime: string | null,
  port: number,
  composeProjectName: string | null = null,
): void {
  db.prepare(
    `INSERT INTO worktree_preview_groups (id, session_id, project_id, status, runtime, compose_project_name)
     VALUES (?, ?, 'proj', 'ready', ?, ?)`,
  ).run(id, `session-${id}`, runtime, composeProjectName);
  db.prepare(
    `INSERT INTO worktree_preview_processes (id, group_id, name, port, url, status, is_primary)
     VALUES (?, ?, 'web', ?, 'http://localhost/', 'ready', 1)`,
  ).run(`${id}:web`, id, port);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

describe('dropComposePreviewColumns', () => {
  it('drops every compose-owned column from an existing database', () => {
    const db = openLegacyDb();
    dropComposePreviewColumns(db);

    const cols = columnNames(db, 'worktree_preview_groups');
    for (const dead of [
      'compose_project_name',
      'worktree_path',
      'compose_file',
      'entry_port',
      'override_file_path',
      'host_project_directory',
    ]) {
      expect(cols).not.toContain(dead);
    }
    // The surviving discriminator and identity columns stay put.
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'session_id',
        'project_id',
        'status',
        'started_at',
        'last_active_at',
        'runtime',
      ]),
    );
    db.close();
  });

  it('is a no-op on a fresh database that never declared the columns', () => {
    const db = new Database(':memory:');
    db.exec(WORKTREE_PREVIEW_GROUPS_SCHEMA);
    const before = columnNames(db, 'worktree_preview_groups');

    expect(() => dropComposePreviewColumns(db)).not.toThrow();
    expect(columnNames(db, 'worktree_preview_groups')).toEqual(before);
    db.close();
  });

  it('is idempotent across repeated boots', () => {
    const db = openLegacyDb();
    dropComposePreviewColumns(db);
    expect(() => dropComposePreviewColumns(db)).not.toThrow();
    expect(columnNames(db, 'worktree_preview_groups')).not.toContain('compose_project_name');
    db.close();
  });

  it('preserves dev-server rows through the drop', () => {
    const db = openLegacyDb();
    insertGroup(db, 'ds-1', DEV_SERVER_RUNTIME_KIND, 4100);
    dropComposePreviewColumns(db);

    const rows = db.prepare(`SELECT id, runtime FROM worktree_preview_groups`).all();
    expect(rows).toEqual([{ id: 'ds-1', runtime: DEV_SERVER_RUNTIME_KIND }]);
    db.close();
  });
});

describe('ensureHostScopedPreviewPortUniqueness', () => {
  /**
   * One group + one process per call. The rebuilt table carries the FK to
   * `worktree_preview_groups`, so the parent has to exist; a separate group
   * per row is also what makes these inserts model *different sessions*
   * rather than one group reusing a port.
   */
  function insertProcess(
    db: Database.Database,
    id: string,
    port: number,
    dialScope: 'host' | 'env',
  ): void {
    db.prepare(
      `INSERT INTO worktree_preview_groups (id, session_id, project_id, status)
       VALUES (?, ?, 'proj', 'ready')`,
    ).run(`group-${id}`, `session-${id}`);
    db.prepare(
      `INSERT INTO worktree_preview_processes
         (id, group_id, name, port, url, status, is_primary, dial_scope)
       VALUES (?, ?, ?, ?, 'http://localhost/', 'ready', 1, ?)`,
    ).run(id, `group-${id}`, `web-${id}`, port, dialScope);
  }

  it('lets two sessions serve the same port inside their own containers', () => {
    // The reason this migration exists. Ports inside a session container are
    // namespaced by that container, so two sessions both running an Angular
    // dev server on 4200 is normal — under the old global UNIQUE(port) the
    // second session's preview failed to start for no reason.
    const db = openLegacyDb();
    ensureHostScopedPreviewPortUniqueness(db);

    insertProcess(db, 'a', 4200, 'env');
    expect(() => insertProcess(db, 'b', 4200, 'env')).not.toThrow();
    db.close();
  });

  it('still rejects two host-dialed rows on one port', () => {
    // Host ports remain a single shared resource: two processes cannot both
    // bind 4101 on the Hub's machine, and the allocator relies on the DB
    // saying so.
    const db = openLegacyDb();
    ensureHostScopedPreviewPortUniqueness(db);

    insertProcess(db, 'a', 4101, 'host');
    expect(() => insertProcess(db, 'b', 4101, 'host')).toThrow(/UNIQUE/i);
    db.close();
  });

  it('carries existing rows through the table rebuild and defaults them to host', () => {
    // Rows written before dial_scope existed were all host-published, so
    // defaulting them to 'host' preserves the constraint they were created
    // under. Losing them would strand live previews the Hub still manages.
    const db = openLegacyDb();
    insertGroup(db, 'ds-1', DEV_SERVER_RUNTIME_KIND, 4100);

    ensureHostScopedPreviewPortUniqueness(db);

    expect(db.prepare(`SELECT id, port, dial_scope FROM worktree_preview_processes`).all()).toEqual(
      [{ id: 'ds-1:web', port: 4100, dial_scope: 'host' }],
    );
    db.close();
  });

  it('drops the old column-level UNIQUE rather than leaving it in force', () => {
    // SQLite cannot remove a column constraint in place, so a partial index
    // alone would not help: the original UNIQUE would keep rejecting the
    // second env-scoped row. This asserts the rebuild actually happened.
    const db = openLegacyDb();
    ensureHostScopedPreviewPortUniqueness(db);

    const sql = (
      db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get('worktree_preview_processes') as { sql: string }
    ).sql;
    expect(sql).not.toMatch(/port\s+INTEGER\s+NOT\s+NULL\s+UNIQUE/i);
    db.close();
  });

  it('keeps the group/name uniqueness the rebuild is not allowed to lose', () => {
    const db = openLegacyDb();
    ensureHostScopedPreviewPortUniqueness(db);

    db.prepare(
      `INSERT INTO worktree_preview_groups (id, session_id, project_id, status)
       VALUES ('g1', 'session-g1', 'proj', 'ready')`,
    ).run();
    db.prepare(
      `INSERT INTO worktree_preview_processes
         (id, group_id, name, port, url, status, is_primary, dial_scope)
       VALUES ('p1', 'g1', 'web', 4200, 'http://localhost/', 'ready', 1, 'env')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO worktree_preview_processes
             (id, group_id, name, port, url, status, is_primary, dial_scope)
           VALUES ('p2', 'g1', 'web', 4300, 'http://localhost/', 'ready', 0, 'env')`,
        )
        .run(),
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  it('is idempotent across repeated boots', () => {
    const db = openLegacyDb();
    ensureHostScopedPreviewPortUniqueness(db);
    expect(() => ensureHostScopedPreviewPortUniqueness(db)).not.toThrow();

    insertProcess(db, 'a', 4200, 'env');
    expect(() => insertProcess(db, 'b', 4200, 'env')).not.toThrow();
    db.close();
  });

  it('is a no-op on a fresh database that already ships the new shape', () => {
    const db = new Database(':memory:');
    db.exec(WORKTREE_PREVIEW_GROUPS_SCHEMA);

    expect(() => ensureHostScopedPreviewPortUniqueness(db)).not.toThrow();
    insertProcess(db, 'a', 4200, 'env');
    expect(() => insertProcess(db, 'b', 4200, 'env')).not.toThrow();
    expect(() => insertProcess(db, 'c', 4101, 'host')).not.toThrow();
    expect(() => insertProcess(db, 'd', 4101, 'host')).toThrow(/UNIQUE/i);
    db.close();
  });
});

describe('deleteOrphanedNonDevServerPreviewRows', () => {
  it('removes compose and legacy-spawn rows but keeps dev-server rows', () => {
    const db = openLegacyDb();
    insertGroup(db, 'compose-1', null, 4101, 'agenthub-session-abc');
    insertGroup(db, 'spawn-1', null, 4102);
    insertGroup(db, 'ds-1', DEV_SERVER_RUNTIME_KIND, 4103);

    const removed = deleteOrphanedNonDevServerPreviewRows(db);

    expect(removed).toBe(2);
    expect(db.prepare(`SELECT id FROM worktree_preview_groups`).all()).toEqual([{ id: 'ds-1' }]);
    db.close();
  });

  it('deletes the orphaned rows child processes so their ports are reclaimable', () => {
    // Without this the UNIQUE(port) invariant would pin 4101 forever: no
    // runtime is left that could stop the row and free it.
    const db = openLegacyDb();
    insertGroup(db, 'compose-1', null, 4101, 'agenthub-session-abc');
    insertGroup(db, 'ds-1', DEV_SERVER_RUNTIME_KIND, 4103);

    deleteOrphanedNonDevServerPreviewRows(db);

    const ports = db
      .prepare(`SELECT port FROM worktree_preview_processes ORDER BY port`)
      .all() as Array<{ port: number }>;
    expect(ports).toEqual([{ port: 4103 }]);

    // The freed port can be allocated again.
    expect(() => insertGroup(db, 'ds-2', DEV_SERVER_RUNTIME_KIND, 4101)).not.toThrow();
    db.close();
  });

  it('works without PRAGMA foreign_keys, which is a per-connection setting', () => {
    const db = openLegacyDb();
    db.pragma('foreign_keys = OFF');
    insertGroup(db, 'compose-1', null, 4101, 'agenthub-session-abc');

    deleteOrphanedNonDevServerPreviewRows(db);

    expect(db.prepare(`SELECT COUNT(*) AS n FROM worktree_preview_processes`).get()).toEqual({
      n: 0,
    });
    db.close();
  });

  it('returns 0 and changes nothing when only dev-server rows exist', () => {
    const db = openLegacyDb();
    insertGroup(db, 'ds-1', DEV_SERVER_RUNTIME_KIND, 4100);

    expect(deleteOrphanedNonDevServerPreviewRows(db)).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM worktree_preview_processes`).get()).toEqual({
      n: 1,
    });
    db.close();
  });
});
