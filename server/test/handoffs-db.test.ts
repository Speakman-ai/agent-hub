/**
 * Unit test for the `handoffs` table + prepared statements that back the
 * <handoff> block protocol. Verifies the row lifecycle:
 *   1. createHandoff inserts a pending row.
 *   2. setHandoffToSession links the target session id.
 *   3. markHandoffDelivered flips status + stamps delivered_at.
 *   4. markHandoffFailed captures an error reason without needing to_session_id.
 *   5. Lookup helpers return the expected rows.
 */
import './setup.js';
import { randomUUID } from 'crypto';
import { getStmts, getDb } from '../db.js';
import type { HandoffRow } from '../types.js';

describe('handoffs — create, link, deliver, fail', () => {
  // Use a unique prefix per run so multiple runs don't collide.
  const prefix = `handoff-test-${randomUUID().slice(0, 8)}`;

  /**
   * The handoffs table has a FK to sessions(from_session_id) and the test DB
   * enables foreign_keys. Helper inserts a minimal session row so handoffs
   * can reference it.
   */
  function ensureSession(id: string): void {
    const stmts = getStmts();
    try {
      stmts.createSession.run(
        id,
        'agent-test',
        `Test session ${id}`,
        'claude-code',
        'claude-opus-4-7',
        0,
        0,
        1,
      );
    } catch {
      // Already exists from a previous test in the same file — ignore.
    }
  }

  beforeAll(() => {
    const stmts = getStmts();
    expect(stmts.createHandoff).toBeDefined();
    expect(stmts.setHandoffToSession).toBeDefined();
    expect(stmts.markHandoffDelivered).toBeDefined();
    expect(stmts.markHandoffFailed).toBeDefined();
    expect(stmts.getHandoffById).toBeDefined();
    expect(stmts.getHandoffByToSession).toBeDefined();
    expect(stmts.getHandoffsFromSession).toBeDefined();
  });

  afterAll(() => {
    const db = getDb();
    db.prepare(`DELETE FROM handoffs WHERE from_session_id LIKE ?`).run(`${prefix}%`);
    db.prepare(`DELETE FROM sessions WHERE id LIKE ?`).run(`${prefix}%`);
  });

  it('createHandoff inserts a pending row with the expected fields', () => {
    const stmts = getStmts();
    ensureSession(`${prefix}-src-a`);
    const id = `${prefix}-create-${randomUUID().slice(0, 6)}`;
    stmts.createHandoff.run(
      id,
      `${prefix}-src-a`,
      'agent-lead',
      'agent-backend',
      'proj-1',
      'Please implement the fix.',
    );
    const row = stmts.getHandoffById.get(id) as HandoffRow | undefined;
    expect(row).toBeDefined();
    expect(row!.id).toBe(id);
    expect(row!.status).toBe('pending');
    expect(row!.to_session_id).toBeNull();
    expect(row!.note).toBe('Please implement the fix.');
    expect(row!.project_id).toBe('proj-1');
    expect(row!.delivered_at).toBeNull();
    expect(row!.error).toBeNull();
  });

  it('setHandoffToSession links the target session without changing status', () => {
    const stmts = getStmts();
    ensureSession(`${prefix}-src-b`);
    const id = `${prefix}-link-${randomUUID().slice(0, 6)}`;
    stmts.createHandoff.run(
      id,
      `${prefix}-src-b`,
      'agent-lead',
      'agent-backend',
      'proj-1',
      'Do the thing.',
    );
    stmts.setHandoffToSession.run(`${prefix}-dst-b`, id);
    const row = stmts.getHandoffById.get(id) as HandoffRow;
    expect(row.to_session_id).toBe(`${prefix}-dst-b`);
    expect(row.status).toBe('pending'); // unchanged
  });

  it('markHandoffDelivered sets status=delivered and stamps delivered_at', () => {
    const stmts = getStmts();
    ensureSession(`${prefix}-src-c`);
    const id = `${prefix}-deliver-${randomUUID().slice(0, 6)}`;
    stmts.createHandoff.run(id, `${prefix}-src-c`, 'agent-lead', 'agent-backend', 'proj-1', 'note');
    stmts.setHandoffToSession.run(`${prefix}-dst-c`, id);
    stmts.markHandoffDelivered.run(id);
    const row = stmts.getHandoffById.get(id) as HandoffRow;
    expect(row.status).toBe('delivered');
    expect(row.delivered_at).not.toBeNull();
    expect(row.error).toBeNull();
  });

  it('markHandoffFailed captures the error without requiring to_session_id', () => {
    const stmts = getStmts();
    ensureSession(`${prefix}-src-d`);
    const id = `${prefix}-fail-${randomUUID().slice(0, 6)}`;
    stmts.createHandoff.run(id, `${prefix}-src-d`, 'agent-lead', 'agent-unknown', 'proj-1', 'note');
    stmts.markHandoffFailed.run('Unknown target agent: agent-unknown', id);
    const row = stmts.getHandoffById.get(id) as HandoffRow;
    expect(row.status).toBe('failed');
    expect(row.error).toBe('Unknown target agent: agent-unknown');
    expect(row.to_session_id).toBeNull();
    expect(row.delivered_at).toBeNull();
  });

  it('getHandoffByToSession returns a delivered handoff by target session id', () => {
    const stmts = getStmts();
    ensureSession(`${prefix}-src-e`);
    const id = `${prefix}-find-${randomUUID().slice(0, 6)}`;
    const toSessionId = `${prefix}-dst-find`;
    stmts.createHandoff.run(
      id,
      `${prefix}-src-e`,
      'agent-lead',
      'agent-backend',
      'proj-1',
      'find me',
    );
    stmts.setHandoffToSession.run(toSessionId, id);
    stmts.markHandoffDelivered.run(id);

    const found = stmts.getHandoffByToSession.get(toSessionId, 'delivered') as HandoffRow;
    expect(found.id).toBe(id);
    expect(found.note).toBe('find me');
  });

  it('getHandoffByToSession does not return pending rows when asked for delivered', () => {
    const stmts = getStmts();
    ensureSession(`${prefix}-src-f`);
    const id = `${prefix}-pending-${randomUUID().slice(0, 6)}`;
    const toSessionId = `${prefix}-dst-pending`;
    stmts.createHandoff.run(
      id,
      `${prefix}-src-f`,
      'agent-lead',
      'agent-backend',
      'proj-1',
      'still pending',
    );
    stmts.setHandoffToSession.run(toSessionId, id);
    // status stays 'pending'
    const found = stmts.getHandoffByToSession.get(toSessionId, 'delivered') as
      | HandoffRow
      | undefined;
    expect(found).toBeUndefined();
  });

  it('getHandoffsFromSession returns all handoffs emitted by a source session in emit order', () => {
    const stmts = getStmts();
    const srcSession = `${prefix}-src-multi`;
    ensureSession(srcSession);
    const id1 = `${prefix}-m1-${randomUUID().slice(0, 6)}`;
    const id2 = `${prefix}-m2-${randomUUID().slice(0, 6)}`;
    stmts.createHandoff.run(id1, srcSession, 'agent-lead', 'agent-backend', 'proj-1', 'first');
    stmts.createHandoff.run(id2, srcSession, 'agent-lead', 'agent-frontend', 'proj-1', 'second');
    const rows = stmts.getHandoffsFromSession.all(srcSession) as HandoffRow[];
    expect(rows).toHaveLength(2);
    expect(rows[0].note).toBe('first');
    expect(rows[1].note).toBe('second');
  });

  it('status CHECK constraint rejects unknown status values', () => {
    const db = getDb();
    ensureSession(`${prefix}-src-x`);
    expect(() =>
      db
        .prepare(
          `INSERT INTO handoffs (id, from_session_id, from_agent_id, to_agent_id, project_id, note, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `${prefix}-bad`,
          `${prefix}-src-x`,
          'agent-lead',
          'agent-backend',
          'proj-1',
          'note',
          'in-flight',
        ),
    ).toThrow();
  });
});
