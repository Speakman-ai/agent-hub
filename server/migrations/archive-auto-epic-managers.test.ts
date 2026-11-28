import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  ARCHIVE_AUTO_EPIC_MANAGERS_MARKER,
  archiveAutoEpicManagers,
} from './archive-auto-epic-managers.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, name TEXT, deleted_at TEXT, updated_at TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT
    );
    CREATE TABLE kanban_epics (
      id TEXT PRIMARY KEY, autonomous INTEGER DEFAULT 0, manager_session_id TEXT, updated_at TEXT
    );
    CREATE TABLE kanban_phases (
      id TEXT PRIMARY KEY, epic_id TEXT, autonomous_running INTEGER DEFAULT 0
    );
  `);
  return db;
}

function epicWithManager(db: Database.Database, epicId: string, sessionName: string): string {
  const sessionId = `s-${epicId}`;
  db.prepare('INSERT INTO sessions (id, name) VALUES (?, ?)').run(sessionId, sessionName);
  db.prepare('INSERT INTO kanban_epics (id, autonomous, manager_session_id) VALUES (?, 1, ?)').run(
    epicId,
    sessionId,
  );
  db.prepare('INSERT INTO kanban_phases (id, epic_id, autonomous_running) VALUES (?, ?, 1)').run(
    `p-${epicId}`,
    epicId,
  );
  return sessionId;
}

function message(db: Database.Database, sessionId: string, role: string, content: string) {
  db.prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)').run(
    sessionId,
    role,
    content,
  );
}

const row = (db: Database.Database, table: string, id: string) =>
  db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>;

describe('archiveAutoEpicManagers', () => {
  let dataDir: string;
  let db: Database.Database;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'epic-managers-'));
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('archives a manager that only got server wake-ups and stops its epic and phases', () => {
    const s = epicWithManager(db, 'e1', 'Epic: Checkout');
    message(db, s, 'user', '# Epic brief: Checkout\n\nEpic `e1`.');
    message(db, s, 'assistant', 'Starting the first card.');
    message(db, s, 'user', '## Epic manager wake-up: Checkout\n\n- Done: card');
    message(db, s, 'system', 'notice');

    const r = archiveAutoEpicManagers({ db, dataDir });

    expect(r).toMatchObject({ ran: true, archived: 1, epicsStopped: 1, kept: 0 });
    expect(row(db, 'sessions', s).deleted_at).not.toBeNull();
    expect(row(db, 'kanban_epics', 'e1')).toMatchObject({
      autonomous: 0,
      manager_session_id: null,
    });
    expect(row(db, 'kanban_phases', 'p-e1').autonomous_running).toBe(0);
    expect(existsSync(path.join(dataDir, ARCHIVE_AUTO_EPIC_MANAGERS_MARKER))).toBe(true);
  });

  it('keeps a manager a person has messaged, and its epic running', () => {
    const s = epicWithManager(db, 'e2', 'Epic: Search');
    message(db, s, 'user', '# Epic brief: Search');
    message(db, s, 'user', 'Skip the spike and start card 3.');

    const r = archiveAutoEpicManagers({ db, dataDir });

    expect(r).toMatchObject({ archived: 0, kept: 1 });
    expect(row(db, 'sessions', s).deleted_at).toBeNull();
    expect(row(db, 'kanban_epics', 'e2')).toMatchObject({ autonomous: 1, manager_session_id: s });
    expect(row(db, 'kanban_phases', 'p-e2').autonomous_running).toBe(1);
  });

  it('leaves managers it did not create alone', () => {
    const s = epicWithManager(db, 'e3', 'Checkout planning');
    archiveAutoEpicManagers({ db, dataDir });
    expect(row(db, 'sessions', s).deleted_at).toBeNull();
    expect(row(db, 'kanban_epics', 'e3').autonomous).toBe(1);
  });

  it('runs once', () => {
    epicWithManager(db, 'e4', 'Epic: Later');
    expect(archiveAutoEpicManagers({ db, dataDir }).ran).toBe(true);
    const s = epicWithManager(db, 'e5', 'Epic: After');

    const again = archiveAutoEpicManagers({ db, dataDir });

    expect(again).toMatchObject({ ran: false, archived: 0 });
    expect(row(db, 'sessions', s).deleted_at).toBeNull();
  });
});
