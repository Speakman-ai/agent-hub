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
import { describe, it, expect, beforeAll } from 'vitest';
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
    expect(bulk.body.archived).toBe(1);
    expect(bulk.body.deleted).toBe(1);

    const liveList = await request.get(`/api/agents/${aid}/sessions`).expect(200);
    expect((liveList.body as Array<{ id: string }>).some((s) => s.id === liveId)).toBe(false);

    const archivedAfter = await request.get(`/api/agents/${aid}/archived-sessions`).expect(200);
    const ids = (archivedAfter.body as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(priorId);
    expect(ids).toContain(liveId);

    await request.post(`/api/sessions/${priorId}/restore`).expect(200);
    await request.post(`/api/sessions/${liveId}/restore`).expect(200);
  });

  it('bulk DELETE inactive soft-archives sessions without an active CLI process', async () => {
    const agent = await createAgent({
      projectId: 'archive-proj',
      id: `inactive-bulk-agent-${Date.now()}`,
      name: 'Inactive bulk isolation',
    });
    const aid = agent.id as string;
    await createSession({ agentId: aid, name: 'idle-1' });
    await createSession({ agentId: aid, name: 'idle-2' });

    const bulk = await request.delete(`/api/agents/${aid}/sessions/inactive`).expect(200);
    expect(bulk.body.archived).toBe(2);
    expect(bulk.body.deleted).toBe(2);

    const liveList = await request.get(`/api/agents/${aid}/sessions`).expect(200);
    expect(liveList.body).toEqual([]);

    const archived = await request.get(`/api/agents/${aid}/archived-sessions`).expect(200);
    expect((archived.body as Array<{ id: string }>).length).toBe(2);
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
