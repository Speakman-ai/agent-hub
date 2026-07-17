import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  MAX_PAYLOAD_BYTES,
  TRUNCATION_MARKER,
  clampPayload,
  isTruncatedPayload,
  pruneOrphanSessionEvents,
  rehydrateTruncatedEvent,
} from './session-events-store.js';

describe('clampPayload', () => {
  it('returns small payloads unchanged', () => {
    const small = JSON.stringify({ type: 'assistant_text', text: 'hi' });
    expect(clampPayload(small)).toBe(small);
  });

  it('passes through a payload exactly at the size cap', () => {
    const exact = 'a'.repeat(MAX_PAYLOAD_BYTES);
    expect(clampPayload(exact)).toBe(exact);
  });

  it('clamps payloads above the cap into a truncation envelope', () => {
    const huge = 'x'.repeat(MAX_PAYLOAD_BYTES + 1024);
    const clamped = clampPayload(huge);
    expect(Buffer.byteLength(clamped, 'utf8')).toBeLessThan(MAX_PAYLOAD_BYTES);

    const parsed = JSON.parse(clamped);
    expect(parsed.__truncated).toBe(TRUNCATION_MARKER);
    expect(parsed.originalBytes).toBe(MAX_PAYLOAD_BYTES + 1024);
    expect(parsed.head.length).toBeGreaterThan(0);
    expect(parsed.tail.length).toBeGreaterThan(0);
    // Head and tail capture the start/end of the original payload.
    expect(huge.startsWith(parsed.head)).toBe(true);
    expect(huge.endsWith(parsed.tail)).toBe(true);
  });

  it('isTruncatedPayload distinguishes envelopes from raw events', () => {
    const small = JSON.stringify({ type: 'assistant_text', text: 'hi' });
    const huge = 'y'.repeat(MAX_PAYLOAD_BYTES * 2);

    expect(isTruncatedPayload(JSON.parse(small))).toBe(false);
    expect(isTruncatedPayload(JSON.parse(clampPayload(huge)))).toBe(true);
    expect(isTruncatedPayload(null)).toBe(false);
    expect(isTruncatedPayload({})).toBe(false);
  });
});

describe('rehydrateTruncatedEvent', () => {
  function envelopeFor(event: unknown): any {
    return JSON.parse(clampPayload(JSON.stringify(event)));
  }

  it('recovers a pairable tool_result from a truncated envelope', () => {
    const env = envelopeFor({
      type: 'tool_result',
      toolUseId: 'toolu_abc123',
      output: 'z'.repeat(MAX_PAYLOAD_BYTES * 2),
      isError: false,
    });
    const ev = rehydrateTruncatedEvent(env);
    expect(ev.type).toBe('tool_result');
    // toolUseId must survive so the paired tool_use card doesn't hang on "running…".
    expect(ev.toolUseId).toBe('toolu_abc123');
    expect(ev.isError).toBe(false);
    expect(ev.truncated).toBe(true);
    expect(String(ev.output)).toContain('too large');
  });

  it('preserves isError=true from the truncated head', () => {
    const env = envelopeFor({
      type: 'tool_result',
      toolUseId: 'toolu_err',
      output: 'q'.repeat(MAX_PAYLOAD_BYTES * 2),
      isError: true,
    });
    expect(rehydrateTruncatedEvent(env).isError).toBe(true);
  });

  it('falls back to the recovered type for non-tool_result events', () => {
    const env = envelopeFor({
      type: 'checkpoint',
      uuid: 'u1',
      raw: 'r'.repeat(MAX_PAYLOAD_BYTES * 2),
    });
    const ev = rehydrateTruncatedEvent(env);
    expect(ev.type).toBe('checkpoint');
    expect(ev.truncated).toBe(true);
  });
});

describe('pruneOrphanSessionEvents', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL
      );
      CREATE TABLE heartbeat_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        prompt TEXT NOT NULL
      );
      CREATE TABLE cron_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cron_id INTEGER NOT NULL,
        result TEXT
      );
      CREATE TABLE session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_kind TEXT NOT NULL,
        parent_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);

    // Seed a live message + live heartbeat + live cron, plus matching
    // events.
    db.prepare(`INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)`).run(
      'msg-live',
      'sess-1',
      'assistant',
      'hi',
    );
    db.prepare(`INSERT INTO heartbeat_logs (agent_id, prompt) VALUES (?, ?)`).run('agent', 'p');
    db.prepare(`INSERT INTO cron_logs (cron_id, result) VALUES (?, ?)`).run(1, 'ok');

    const insertEvent = db.prepare(
      `INSERT INTO session_events (parent_kind, parent_id, seq, event_type, payload)
       VALUES (?, ?, ?, ?, ?)`,
    );
    // Live events (parent rows exist).
    insertEvent.run('message', 'msg-live', 1, 'assistant_text', '{}');
    insertEvent.run('heartbeat', '1', 1, 'tool_use', '{}');
    insertEvent.run('cron', '1', 1, 'result', '{}');
    // Orphan events (parent rows absent).
    insertEvent.run('message', 'msg-gone-1', 1, 'tool_result', '{}');
    insertEvent.run('message', 'msg-gone-1', 2, 'tool_result', '{}');
    insertEvent.run('message', 'msg-gone-2', 1, 'assistant_text', '{}');
    insertEvent.run('heartbeat', '999', 1, 'system', '{}');
    insertEvent.run('cron', '999', 1, 'progress_step', '{}');
  });

  it('deletes orphan rows per parent_kind and keeps live ones', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM session_events').get() as { n: number };
    expect(before.n).toBe(8);

    const result = pruneOrphanSessionEvents(db);

    expect(result.messageOrphans).toBe(3);
    expect(result.heartbeatOrphans).toBe(1);
    expect(result.cronOrphans).toBe(1);
    expect(result.totalDeleted).toBe(5);

    const after = db.prepare('SELECT COUNT(*) AS n FROM session_events').get() as { n: number };
    expect(after.n).toBe(3);

    const live = db
      .prepare('SELECT parent_kind, parent_id FROM session_events ORDER BY parent_kind')
      .all();
    expect(live).toEqual([
      { parent_kind: 'cron', parent_id: '1' },
      { parent_kind: 'heartbeat', parent_id: '1' },
      { parent_kind: 'message', parent_id: 'msg-live' },
    ]);
  });

  it('is idempotent — second call deletes nothing', () => {
    pruneOrphanSessionEvents(db);
    const second = pruneOrphanSessionEvents(db);
    expect(second.totalDeleted).toBe(0);
  });

  it('returns zero counts when no orphans exist', () => {
    db.exec(`DELETE FROM session_events WHERE parent_id IN ('msg-gone-1', 'msg-gone-2', '999')`);
    const result = pruneOrphanSessionEvents(db);
    expect(result.totalDeleted).toBe(0);
  });
});
