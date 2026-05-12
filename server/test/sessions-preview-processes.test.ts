/**
 * Integration tests for `GET /api/sessions/:sessionId/preview/processes`.
 *
 * The route reads directly from the `worktree_preview_groups` /
 * `worktree_preview_processes` tables (no PreviewRuntime instance
 * required at request time), so the tests seed those tables and assert
 * on the response shape:
 *
 *   - Owner missing → 404 (not 403, not 200) so foreign sessions can't
 *     be probed for existence via this surface.
 *   - No active group → `{ group: null, processes: [] }` (NOT 404 — the
 *     endpoint exists, the session has no preview).
 *   - Active group → `{ group: {...}, processes: [{...}, ...] }` ordered
 *     by `started_at ASC, name ASC`.
 *   - When multiple groups exist for one session, only the most-recent
 *     active one is returned (matches `ORDER BY started_at DESC LIMIT 1`).
 */
import type supertest from 'supertest';
import { getRequest, createSession } from './helpers.js';
import { getDb } from '../db.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

function seedGroup(opts: {
  id: string;
  sessionId: string;
  projectId: string;
  status: 'starting' | 'ready' | 'failed';
  startedAt?: string;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO worktree_preview_groups
       (id, session_id, project_id, status, started_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.sessionId,
    opts.projectId,
    opts.status,
    opts.startedAt ?? new Date().toISOString(),
    opts.startedAt ?? new Date().toISOString(),
  );
}

function seedProcess(opts: {
  id: string;
  groupId: string;
  name: string;
  port: number;
  status: 'pending' | 'starting' | 'ready' | 'failed';
  startedAt?: string;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO worktree_preview_processes
       (id, group_id, name, pid, port, url, log_path, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.groupId,
    opts.name,
    null,
    opts.port,
    `http://localhost:${opts.port}`,
    null,
    opts.status,
    opts.startedAt ?? new Date().toISOString(),
  );
}

describe('GET /api/sessions/:sessionId/preview/processes', () => {
  it('returns 404 for a non-existent session (ownership check)', async () => {
    // userOwnsSession resolves to false for an unknown id; the route must
    // surface that as a 404 — never 403 / 200 — so a malicious caller
    // can't enumerate session ids.
    const res = await request.get('/api/sessions/does-not-exist/preview/processes');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns {group:null, processes:[]} when the session has no preview group', async () => {
    const session = await createSession();
    const res = await request.get(`/api/sessions/${session.id}/preview/processes`).expect(200);
    expect(res.body).toEqual({ group: null, processes: [] });
  });

  it('returns the active group + ordered processes for a session', async () => {
    const session = await createSession();
    const sid = session.id as string;
    const groupId = `grp-${sid}`;

    // Older, started_at earlier — should appear first by ASC order.
    seedGroup({
      id: groupId,
      sessionId: sid,
      projectId: 'proj-x',
      status: 'ready',
      startedAt: '2026-05-01T00:00:00.000Z',
    });
    seedProcess({
      id: `${groupId}:backend`,
      groupId,
      name: 'backend',
      port: 4100,
      status: 'ready',
      startedAt: '2026-05-01T00:00:01.000Z',
    });
    seedProcess({
      id: `${groupId}:frontend`,
      groupId,
      name: 'frontend',
      port: 4101,
      status: 'ready',
      startedAt: '2026-05-01T00:00:02.000Z',
    });

    const res = await request.get(`/api/sessions/${sid}/preview/processes`).expect(200);
    expect(res.body.group).toMatchObject({
      id: groupId,
      session_id: sid,
      project_id: 'proj-x',
      status: 'ready',
    });
    expect(res.body.processes).toHaveLength(2);
    // ORDER BY started_at ASC, name ASC — backend first.
    expect(res.body.processes[0]).toMatchObject({
      name: 'backend',
      port: 4100,
      url: 'http://localhost:4100',
      status: 'ready',
    });
    expect(res.body.processes[1]).toMatchObject({
      name: 'frontend',
      port: 4101,
      url: 'http://localhost:4101',
      status: 'ready',
    });
  });

  it('returns the most recent active group when multiple exist (DESC LIMIT 1)', async () => {
    const session = await createSession();
    const sid = session.id as string;

    seedGroup({
      id: `older-${sid}`,
      sessionId: sid,
      projectId: 'proj-x',
      status: 'failed',
      startedAt: '2026-05-01T00:00:00.000Z',
    });
    seedProcess({
      id: `older-${sid}:app`,
      groupId: `older-${sid}`,
      name: 'app',
      port: 4110,
      status: 'failed',
    });

    seedGroup({
      id: `newer-${sid}`,
      sessionId: sid,
      projectId: 'proj-x',
      status: 'starting',
      startedAt: '2026-05-02T00:00:00.000Z',
    });
    seedProcess({
      id: `newer-${sid}:app`,
      groupId: `newer-${sid}`,
      name: 'app',
      port: 4111,
      status: 'starting',
    });

    const res = await request.get(`/api/sessions/${sid}/preview/processes`).expect(200);
    expect(res.body.group.id).toBe(`newer-${sid}`);
    expect(res.body.group.status).toBe('starting');
    expect(res.body.processes).toHaveLength(1);
    expect(res.body.processes[0].port).toBe(4111);
  });

  it('includes failed groups (replace-on-restart guard relies on them being visible)', async () => {
    const session = await createSession();
    const sid = session.id as string;
    const groupId = `failed-${sid}`;

    seedGroup({
      id: groupId,
      sessionId: sid,
      projectId: 'proj-x',
      status: 'failed',
    });
    seedProcess({
      id: `${groupId}:app`,
      groupId,
      name: 'app',
      port: 4120,
      status: 'failed',
    });

    const res = await request.get(`/api/sessions/${sid}/preview/processes`).expect(200);
    expect(res.body.group).not.toBeNull();
    expect(res.body.group.status).toBe('failed');
    expect(res.body.processes[0].status).toBe('failed');
  });
});
