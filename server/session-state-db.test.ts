import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Stmts } from './types.js';
import {
  computeSessionState,
  gatherSessionStateSignals,
  recomputeSessionState,
} from './session-state.js';
import { enrichSessionForClient } from './session-checkpoint-rewind.js';

/**
 * Build a minimal in-memory DB + partial `Stmts` carrying only the statements
 * the session-state resolver touches. Mirrors the raw-SQL approach in
 * boot-recovery.test.ts so we don't drag the full schema in.
 */
function makeStmts(): { db: Database.Database; stmts: Stmts } {
  const db = new Database(':memory:');
  // Mirror the real schema's shape: kanban_cards carry a `column_id` and the
  // done/merge signal is Done-column membership (kanban_columns.name contains
  // "done") — NOT a `review_status === 'merged'` value, which the production
  // CHECK constraint forbids.
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT, engine TEXT, state TEXT);
    CREATE TABLE active_tasks (session_id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE kanban_columns (id TEXT PRIMARY KEY, board_id TEXT, name TEXT, position INTEGER);
    CREATE TABLE kanban_cards (id TEXT, session_id TEXT, column_id TEXT, board_id TEXT);
    CREATE TABLE finalize_runs (id TEXT, session_id TEXT, status TEXT, mode TEXT, validated_head_sha TEXT, created_at INTEGER);
  `);
  const stmts = {
    getActiveTask: db.prepare('SELECT * FROM active_tasks WHERE session_id = ?'),
    getKanbanCardBySession: db.prepare('SELECT * FROM kanban_cards WHERE session_id = ? LIMIT 1'),
    getKanbanColumn: db.prepare('SELECT * FROM kanban_columns WHERE id = ?'),
    getLatestFinalizeRunForSession: db.prepare(
      'SELECT * FROM finalize_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1',
    ),
    getLatestChecksRunForSession: db.prepare(
      "SELECT * FROM finalize_runs WHERE session_id = ? AND mode IN ('full','checks') ORDER BY created_at DESC LIMIT 1",
    ),
    getLatestReviewRunForSession: db.prepare(
      "SELECT * FROM finalize_runs WHERE session_id = ? AND mode IN ('full','review') ORDER BY created_at DESC LIMIT 1",
    ),
    updateSessionState: db.prepare('UPDATE sessions SET state = ? WHERE id = ?'),
  } as unknown as Stmts;
  return { db, stmts };
}

describe('session-state DB integration', () => {
  let db: Database.Database;
  let stmts: Stmts;

  beforeEach(() => {
    ({ db, stmts } = makeStmts());
    db.prepare('INSERT INTO sessions (id, agent_id, engine) VALUES (?,?,?)').run(
      's1',
      'a1',
      'claude-code',
    );
  });

  it('computes waiting_for_user_input for a fresh idle session', () => {
    expect(computeSessionState(stmts, 's1')).toBe('waiting_for_user_input');
  });

  it('computes working when an active task is running', () => {
    db.prepare('INSERT INTO active_tasks (session_id, status) VALUES (?,?)').run('s1', 'running');
    expect(computeSessionState(stmts, 's1')).toBe('working');
  });

  it('computes running_tests from an in-flight full finalize run', () => {
    db.prepare(
      'INSERT INTO finalize_runs (id, session_id, status, mode, created_at) VALUES (?,?,?,?,?)',
    ).run('r1', 's1', 'running', 'full', 1);
    expect(computeSessionState(stmts, 's1')).toBe('running_tests');
  });

  it('computes merged when the linked card sits in a Done column', () => {
    db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?,?,?,?)').run(
      'col-done',
      'b1',
      'Done',
      3,
    );
    db.prepare(
      'INSERT INTO kanban_cards (id, session_id, column_id, board_id) VALUES (?,?,?,?)',
    ).run('c1', 's1', 'col-done', 'b1');
    const sig = gatherSessionStateSignals(stmts, 's1');
    expect(sig.merged).toBe(true);
    expect(computeSessionState(stmts, 's1')).toBe('merged');
  });

  it('matches Done-column membership case-insensitively and by substring', () => {
    db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?,?,?,?)').run(
      'col-deployed',
      'b1',
      'Deployed / Done ✅',
      4,
    );
    db.prepare(
      'INSERT INTO kanban_cards (id, session_id, column_id, board_id) VALUES (?,?,?,?)',
    ).run('c1', 's1', 'col-deployed', 'b1');
    expect(gatherSessionStateSignals(stmts, 's1').merged).toBe(true);
  });

  it('does NOT mark merged when the linked card is in a non-Done column', () => {
    db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?,?,?,?)').run(
      'col-review',
      'b1',
      'Review',
      2,
    );
    db.prepare(
      'INSERT INTO kanban_cards (id, session_id, column_id, board_id) VALUES (?,?,?,?)',
    ).run('c1', 's1', 'col-review', 'b1');
    expect(gatherSessionStateSignals(stmts, 's1').merged).toBe(false);
    expect(computeSessionState(stmts, 's1')).toBe('waiting_for_user_input');
  });

  it('recompute persists the resolved state into sessions.state', () => {
    db.prepare('INSERT INTO active_tasks (session_id, status) VALUES (?,?)').run('s1', 'running');
    const state = recomputeSessionState(stmts, 's1', { agentId: 'a1' });
    expect(state).toBe('working');
    const row = db.prepare('SELECT state FROM sessions WHERE id = ?').get('s1') as {
      state: string;
    };
    expect(row.state).toBe('working');
  });

  it('recompute broadcasts a session_state event with the resolved state', () => {
    const events: unknown[] = [];
    recomputeSessionState(stmts, 's1', { agentId: 'a1', broadcast: (m) => events.push(m) });
    expect(events).toEqual([
      { type: 'session_state', sessionId: 's1', agentId: 'a1', state: 'waiting_for_user_input' },
    ]);
  });

  it('enrichSessionForClient resolves the live state when stmts is threaded', () => {
    db.prepare(
      'INSERT INTO finalize_runs (id, session_id, status, mode, created_at) VALUES (?,?,?,?,?)',
    ).run('r1', 's1', 'pushed', 'full', 1);
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as never;
    const wire = enrichSessionForClient(row, stmts);
    expect(wire.state).toBe('pushed');
    expect(wire.finalize_status).toBe('pushed');
  });

  it('enrichSessionForClient falls back to the persisted column without stmts', () => {
    const row = { id: 's1', engine: 'claude-code', state: 'reviewing' } as never;
    const wire = enrichSessionForClient(row);
    expect(wire.state).toBe('reviewing');
  });

  it('enrichSessionForClient defaults to waiting when no stmts and no stored state', () => {
    const row = { id: 's1', engine: 'claude-code' } as never;
    const wire = enrichSessionForClient(row);
    expect(wire.state).toBe('waiting_for_user_input');
  });
});
