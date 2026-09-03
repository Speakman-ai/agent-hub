import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, getStmts, initDb } from './db.js';

let columns: string[] = [];
let rows: Array<{
  id: string;
  session_id: string;
  agent_id: string;
  model: string | null;
  engine: string | null;
}> = [];

beforeAll(() => {
  const sourceDir = mkdtempSync(path.join(tmpdir(), 'ah-session-agents-source-'));
  const legacyDir = mkdtempSync(path.join(tmpdir(), 'ah-session-agents-legacy-'));
  const legacyPath = path.join(legacyDir, 'agent-hub.db');

  initDb(sourceDir);
  getStmts().createSession.run(
    'session-1',
    'agent-1',
    'Legacy multi-agent session',
    'claude-code',
    'claude-opus-5',
    1,
    0,
    1,
  );
  getDb().exec(`VACUUM INTO '${legacyPath.replaceAll("'", "''")}'`);

  const legacy = new Database(legacyPath);
  legacy.pragma('foreign_keys = OFF');
  legacy.exec(`
    DROP TABLE session_agents;
    CREATE TABLE session_agents (
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, agent_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_session_agents_session ON session_agents(session_id);
    INSERT INTO session_agents (session_id, agent_id, position)
    VALUES ('session-1', 'agent-2', 0);
  `);
  legacy.close();

  initDb(legacyDir);
  const upgraded = getDb();
  columns = (
    upgraded.prepare('PRAGMA table_info(session_agents)').all() as Array<{ name: string }>
  ).map((column) => column.name);
  getStmts().addSessionAgent.run(
    'participant-2',
    'session-1',
    'agent-2',
    'model-b',
    'codex-cli',
    'session-1',
  );
  rows = upgraded
    .prepare('SELECT id, session_id, agent_id, model, engine FROM session_agents ORDER BY position')
    .all() as typeof rows;
});

describe('session_agents participant-instance migration', () => {
  it('preserves legacy advisors and permits duplicate agent instances with models', () => {
    expect(columns).toContain('id');
    expect(columns).toContain('model');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.agent_id).toBe('agent-2');
    expect(rows[0]!.id).toBeTruthy();
    expect(rows[0]!.model).toBeNull();
    // Legacy advisor rows migrate in with no engine override (inherit the agent).
    expect(rows[0]!.engine).toBeNull();
    expect(rows[1]).toMatchObject({
      id: 'participant-2',
      session_id: 'session-1',
      agent_id: 'agent-2',
      model: 'model-b',
    });
  });

  it('adds the nullable engine column and stores a per-participant override', () => {
    expect(columns).toContain('engine');
    // The override lets the same agent run as a different CLI for cross-check.
    expect(rows[1]!.engine).toBe('codex-cli');
  });
});
