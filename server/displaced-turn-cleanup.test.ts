import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { clearOwnActiveTaskAfterDisplacedClose } from './displaced-turn-cleanup.js';
import {
  claimSessionProcessSlot,
  releaseSessionProcessSlot,
  type ActiveChatProcess,
} from './active-chat-process.js';
import type { Stmts } from './types.js';

function makeStmts() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE active_tasks (
    session_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running'
  )`);
  const stmts = {
    deleteActiveTaskForMessage: db.prepare(
      'DELETE FROM active_tasks WHERE session_id = ? AND message_id = ?',
    ),
    getActiveTask: db.prepare('SELECT * FROM active_tasks WHERE session_id = ?'),
    updateSessionState: { run: vi.fn() },
  } as unknown as Stmts;
  return { db, stmts };
}

describe('clearOwnActiveTaskAfterDisplacedClose', () => {
  it('removes the displaced turn’s own row so the session stops reading as working', () => {
    const { db, stmts } = makeStmts();
    db.prepare('INSERT INTO active_tasks (session_id, message_id) VALUES (?, ?)').run('s1', 'm1');
    const broadcast = vi.fn();

    expect(clearOwnActiveTaskAfterDisplacedClose(stmts, 's1', 'm1', { broadcast })).toBe(true);

    expect(db.prepare('SELECT COUNT(*) n FROM active_tasks').get()).toEqual({ n: 0 });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_state', sessionId: 's1' }),
    );
    expect(broadcast.mock.calls[0]?.[0].state).not.toBe('working');
  });

  it('leaves a newer turn’s row alone', () => {
    const { db, stmts } = makeStmts();
    db.prepare('INSERT INTO active_tasks (session_id, message_id) VALUES (?, ?)').run('s1', 'm2');

    expect(clearOwnActiveTaskAfterDisplacedClose(stmts, 's1', 'm1')).toBe(false);

    expect(db.prepare('SELECT message_id FROM active_tasks').get()).toEqual({ message_id: 'm2' });
  });
});

describe('session process slot', () => {
  const handle = (): ActiveChatProcess => ({ kill: vi.fn() }) as unknown as ActiveChatProcess;

  it('does not displace an occupant and only releases its own handle', () => {
    const map = new Map<string, ActiveChatProcess>();
    const chat = handle();
    const reviewer = handle();
    map.set('s1', chat);

    expect(claimSessionProcessSlot(map, 's1', reviewer)).toBe(false);
    releaseSessionProcessSlot(map, 's1', reviewer);
    expect(map.get('s1')).toBe(chat);

    map.delete('s1');
    expect(claimSessionProcessSlot(map, 's1', reviewer)).toBe(true);
    releaseSessionProcessSlot(map, 's1', reviewer);
    expect(map.has('s1')).toBe(false);
  });
});
