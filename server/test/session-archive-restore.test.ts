/**
 * Tests for the session archive / restore round-trip.
 *
 * Regression coverage for the bug where the UI offered a "Restore archived
 * session" action but the server had no matching
 * `GET /api/agents/:agentId/archived-sessions` /
 * `POST /api/sessions/:sessionId/restore` routes, producing a 404.
 *
 * Flow under test:
 *   1. DELETE /api/sessions/:id   — soft-deletes (marks `deleted_at`).
 *   2. GET /api/agents/:agentId/sessions           — live list excludes it.
 *   3. GET /api/agents/:agentId/archived-sessions  — archive list includes it.
 *   4. POST /api/sessions/:id/restore              — clears `deleted_at`.
 *   5. GET /api/agents/:agentId/sessions           — it's back in the live list.
 */

import './setup.js';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { getRequest, createProject, createAgent, createSession } from './helpers.js';
import type TestAgent from 'supertest/lib/agent.js';

let request: TestAgent;
let agentId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject({ id: 'archive-proj', name: 'Archive Project', cwd: '/tmp' });
  const agent = await createAgent({
    projectId: project.id as string,
    id: 'archive-agent',
    name: 'Archive Agent',
  });
  agentId = agent.id as string;
});

describe('Session archive & restore', () => {
  it('DELETE /api/sessions/:id soft-deletes (hides from live list) and restore round-trips', async () => {
    const session = await createSession({ agentId, name: 'doomed' });
    const sessionId = session.id as string;

    // Archive
    const del = await request.delete(`/api/sessions/${sessionId}`).expect(200);
    expect(del.body).toMatchObject({ ok: true, archived: true });

    // Live list excludes it
    const live = await request.get(`/api/agents/${agentId}/sessions`).expect(200);
    expect((live.body as Array<{ id: string }>).some((s) => s.id === sessionId)).toBe(false);

    // Archive list includes it with a deleted_at timestamp
    const archived = await request.get(`/api/agents/${agentId}/archived-sessions`).expect(200);
    const archivedRow = (archived.body as Array<{ id: string; deleted_at: string | null }>).find(
      (s) => s.id === sessionId,
    );
    expect(archivedRow).toBeDefined();
    expect(archivedRow!.deleted_at).toBeTruthy();

    // Restore
    const restored = await request.post(`/api/sessions/${sessionId}/restore`).expect(200);
    expect(restored.body.id).toBe(sessionId);
    expect(restored.body.deleted_at).toBeNull();

    // Live list includes it again; archive list drops it
    const liveAfter = await request.get(`/api/agents/${agentId}/sessions`).expect(200);
    expect((liveAfter.body as Array<{ id: string }>).some((s) => s.id === sessionId)).toBe(true);

    const archivedAfter = await request.get(`/api/agents/${agentId}/archived-sessions`).expect(200);
    expect((archivedAfter.body as Array<{ id: string }>).some((s) => s.id === sessionId)).toBe(
      false,
    );
  });

  it('moves the linked card to Done on archive and back to In Progress on restore', async () => {
    const suffix = Date.now().toString(36);
    const projectId = `card-lifecycle-project-${suffix}`;
    const project = await createProject({
      id: projectId,
      name: 'Card lifecycle project',
      cwd: '/tmp',
    });
    const agent = await createAgent({
      projectId: project.id as string,
      id: `card-lifecycle-agent-${suffix}`,
      name: 'Card lifecycle agent',
    });
    const session = await createSession({
      agentId: agent.id as string,
      name: 'close and restore card',
    });
    const sessionId = session.id as string;

    const { randomUUID } = await import('node:crypto');
    const { db } = await import('../db.js');
    if (!db) throw new Error('Database not initialized');

    const boardId = randomUUID();
    const inProgressId = randomUUID();
    const doneId = randomUUID();
    const cardId = randomUUID();
    db.prepare('INSERT INTO kanban_boards (id, project_id, name) VALUES (?,?,?)').run(
      boardId,
      projectId,
      'Card lifecycle board',
    );
    db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?,?,?,?)').run(
      inProgressId,
      boardId,
      'In Progress',
      0,
    );
    db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?,?,?,?)').run(
      doneId,
      boardId,
      'Done',
      1,
    );
    db.prepare(
      'INSERT INTO kanban_cards (id, column_id, board_id, title, session_id) VALUES (?,?,?,?,?)',
    ).run(cardId, inProgressId, boardId, 'Session-owned ticket', sessionId);

    await request.delete(`/api/sessions/${sessionId}`).expect(200);
    expect(db.prepare('SELECT column_id FROM kanban_cards WHERE id = ?').get(cardId)).toMatchObject(
      { column_id: doneId },
    );

    // Older Hub versions marked retained cards orphaned on archive. Restoring
    // one must clear that stale badge as well as reactivate the card.
    db.prepare("UPDATE kanban_cards SET orphaned_at = datetime('now') WHERE id = ?").run(cardId);

    await request.post(`/api/sessions/${sessionId}/restore`).expect(200);
    expect(
      db.prepare('SELECT column_id, orphaned_at FROM kanban_cards WHERE id = ?').get(cardId),
    ).toMatchObject({ column_id: inProgressId, orphaned_at: null });
  });

  it('GET /archived-sessions returns empty array when nothing is archived', async () => {
    // Use a fresh agent so prior tests don't pollute the result.
    const agent = await createAgent({
      projectId: 'archive-proj',
      id: `clean-agent-${Date.now()}`,
      name: 'Clean',
    });
    const res = await request.get(`/api/agents/${agent.id}/archived-sessions`).expect(200);
    expect(res.body).toEqual([]);
  });

  it('POST /sessions/:id/restore returns 404 for a non-existent session', async () => {
    const res = await request.post('/api/sessions/does-not-exist-0000/restore').expect(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('POST /sessions/:id/restore returns 409 when the session is not archived', async () => {
    const session = await createSession({ agentId, name: 'still-active' });
    const res = await request.post(`/api/sessions/${session.id}/restore`).expect(409);
    expect(res.body.error).toMatch(/not archived/i);
  });

  it('bulk DELETE soft-archives live sessions and leaves prior archives restorable', async () => {
    const agent = await createAgent({
      projectId: 'archive-proj',
      id: `bulk-archive-agent-${Date.now()}`,
      name: 'Bulk archive isolation',
    });
    const aid = agent.id as string;

    const alreadyArchived = await createSession({ agentId: aid, name: 'prior-archive' });
    const priorId = alreadyArchived.id as string;
    await request.delete(`/api/sessions/${priorId}`).expect(200);

    const stillLive = await createSession({ agentId: aid, name: 'bulk-to-archive' });
    const liveId = stillLive.id as string;

    const bulk = await request.delete(`/api/agents/${aid}/sessions`).expect(200);
    expect(bulk.body.ok).toBe(true);
    expect(bulk.body.archived).toBe(1);
    expect(bulk.body.deleted).toBe(1);
    expect(bulk.body.failed).toBe(0);
    expect(bulk.body.archivedIds).toEqual([liveId]);

    const liveList = await request.get(`/api/agents/${aid}/sessions`).expect(200);
    expect((liveList.body as Array<{ id: string }>).some((s) => s.id === liveId)).toBe(false);

    const archivedAfter = await request.get(`/api/agents/${aid}/archived-sessions`).expect(200);
    const ids = (archivedAfter.body as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(priorId);
    expect(ids).toContain(liveId);

    await request.post(`/api/sessions/${priorId}/restore`).expect(200);
    await request.post(`/api/sessions/${liveId}/restore`).expect(200);
  });

  it('bulk DELETE skips archive when session env teardown fails', async () => {
    const agent = await createAgent({
      projectId: 'archive-proj',
      id: `bulk-teardown-fail-${Date.now()}`,
      name: 'Bulk teardown fail',
    });
    const aid = agent.id as string;
    const live = await createSession({ agentId: aid, name: 'teardown-fail' });
    const liveId = live.id as string;

    const { routeDeps } = await import('../index.js');
    const prevDispose = routeDeps.disposeSessionEnv;
    routeDeps.disposeSessionEnv = vi.fn(async () => {
      throw new Error('vmm still running');
    });
    try {
      const bulk = await request.delete(`/api/agents/${aid}/sessions`).expect(500);
      expect(bulk.body.ok).toBe(false);
      expect(bulk.body.archived).toBe(0);
      expect(bulk.body.failed).toBe(1);
      expect(bulk.body.archivedIds).toEqual([]);

      const liveList = await request.get(`/api/agents/${aid}/sessions`).expect(200);
      expect((liveList.body as Array<{ id: string }>).some((s) => s.id === liveId)).toBe(true);
    } finally {
      routeDeps.disposeSessionEnv = prevDispose;
    }
  });

  it('bulk DELETE pushed archives only sessions whose state is `pushed`, keeping the rest', async () => {
    const agent = await createAgent({
      projectId: 'archive-proj',
      id: `pushed-bulk-agent-${Date.now()}`,
      name: 'Pushed bulk isolation',
    });
    const aid = agent.id as string;

    // One session with a settled `pushed` finalize run → state resolves to
    // `pushed` and should be archived.
    const pushed = await createSession({ agentId: aid, name: 'pushed-1' });
    const pushedId = pushed.id as string;
    // One plain idle session (no finalize run) → state is the default
    // `waiting_for_user_input` and must be kept.
    const idle = await createSession({ agentId: aid, name: 'idle-keep' });
    const idleId = idle.id as string;

    const { randomUUID } = await import('node:crypto');
    const { stmts } = await import('../db.js');
    if (!stmts) throw new Error('Database not initialized');
    const runId = randomUUID();
    stmts.insertFinalizeRun.run(
      runId,
      `card-${runId}`,
      pushedId,
      'archive-proj',
      'feature/pushed',
      'sha-pushed',
      `pushed-${runId}`,
      'pushed',
      'push',
      'ui_button',
      '/tmp/pushed',
      'owner-user',
      'Agent Hub',
      'agent@example.test',
      null,
      Date.now(),
      'full',
    );

    const bulk = await request.delete(`/api/agents/${aid}/sessions/pushed`).expect(200);
    expect(bulk.body.archived).toBe(1);
    expect(bulk.body.deleted).toBe(1);

    // Only the idle session remains live.
    const liveList = await request.get(`/api/agents/${aid}/sessions`).expect(200);
    const liveIds = (liveList.body as Array<{ id: string }>).map((s) => s.id);
    expect(liveIds).toEqual([idleId]);

    // The pushed session is the only one archived.
    const archived = await request.get(`/api/agents/${aid}/archived-sessions`).expect(200);
    const archivedIds = (archived.body as Array<{ id: string }>).map((s) => s.id);
    expect(archivedIds).toEqual([pushedId]);
  });

  it('bulk DELETE merged archives only sessions whose state is `merged`, keeping the rest', async () => {
    const agent = await createAgent({
      projectId: 'archive-proj',
      id: `merged-bulk-agent-${Date.now()}`,
      name: 'Merged bulk isolation',
    });
    const aid = agent.id as string;

    // One session whose linked kanban card sits in a Done column → state
    // resolves to `merged` and should be archived.
    const merged = await createSession({ agentId: aid, name: 'merged-1' });
    const mergedId = merged.id as string;
    // One session with a settled `pushed` finalize run → state is `pushed` and
    // must be kept (this is the companion endpoint's blind spot, not its job).
    const pushed = await createSession({ agentId: aid, name: 'pushed-keep' });
    const pushedId = pushed.id as string;
    // One plain idle session (no finalize run, no card) → default
    // `waiting_for_user_input` and must be kept.
    const idle = await createSession({ agentId: aid, name: 'idle-keep' });
    const idleId = idle.id as string;

    const { randomUUID } = await import('node:crypto');
    const { db, stmts } = await import('../db.js');
    if (!db || !stmts) throw new Error('Database not initialized');

    // Build a board with a Done column and link the merged session's card to it.
    const boardId = randomUUID();
    const doneColId = randomUUID();
    const cardId = randomUUID();
    db.prepare('INSERT INTO kanban_boards (id, project_id, name) VALUES (?,?,?)').run(
      boardId,
      'archive-proj',
      'Merged bulk board',
    );
    db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?,?,?,?)').run(
      doneColId,
      boardId,
      'Done',
      0,
    );
    db.prepare(
      'INSERT INTO kanban_cards (id, column_id, board_id, title, session_id) VALUES (?,?,?,?,?)',
    ).run(cardId, doneColId, boardId, 'merged card', mergedId);

    // Settle the kept session into `pushed`.
    const runId = randomUUID();
    stmts.insertFinalizeRun.run(
      runId,
      `card-${runId}`,
      pushedId,
      'archive-proj',
      'feature/pushed',
      'sha-pushed',
      `pushed-${runId}`,
      'pushed',
      'push',
      'ui_button',
      '/tmp/pushed',
      'owner-user',
      'Agent Hub',
      'agent@example.test',
      null,
      Date.now(),
      'full',
    );

    const bulk = await request.delete(`/api/agents/${aid}/sessions/merged`).expect(200);
    expect(bulk.body.archived).toBe(1);
    expect(bulk.body.deleted).toBe(1);

    // The pushed + idle sessions remain live; merged is gone.
    const liveList = await request.get(`/api/agents/${aid}/sessions`).expect(200);
    const liveIds = (liveList.body as Array<{ id: string }>).map((s) => s.id).sort();
    expect(liveIds).toEqual([pushedId, idleId].sort());

    // The merged session is the only one archived.
    const archived = await request.get(`/api/agents/${aid}/archived-sessions`).expect(200);
    const archivedIds = (archived.body as Array<{ id: string }>).map((s) => s.id);
    expect(archivedIds).toEqual([mergedId]);
  });

  it('archiving the same session twice is idempotent (still 200, stays archived)', async () => {
    const session = await createSession({ agentId, name: 'double-archive' });
    const sessionId = session.id as string;

    await request.delete(`/api/sessions/${sessionId}`).expect(200);
    // Second DELETE on the already-archived row: the row still exists in the
    // DB (soft-delete doesn't remove it), so getSession returns it and the
    // route responds 200. This mirrors the old hard-delete behaviour where
    // deleting a missing row was also a no-op success.
    await request.delete(`/api/sessions/${sessionId}`).expect(200);

    const archived = await request.get(`/api/agents/${agentId}/archived-sessions`).expect(200);
    expect((archived.body as Array<{ id: string }>).some((s) => s.id === sessionId)).toBe(true);
  });
});
