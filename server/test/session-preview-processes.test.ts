/**
 * Integration tests for GET /api/sessions/:sessionId/preview/processes.
 *
 * Covers:
 *   1. Empty-state shape `{ group: null, processes: [] }` when no active
 *      group exists for the session.
 *   2. Populated shape when a group + process rows are present in the DB.
 *   3. `userOwnsSession` → 404 for non-owners (the comment on the route
 *      promises "404 to non-owners"; this is easy to regress to 403 or
 *      200 if the ownership check were accidentally removed).
 */
import './setup.js';
import type supertest from 'supertest';
import { randomUUID } from 'crypto';
import { unlinkSync, existsSync } from 'fs';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { getRequest, createSession } from './helpers.js';
import { getDb } from '../db.js';
import { saveAuthRecord, reloadAuthRecord, generateJwtSecret } from '../auth-store.js';
import { signJwt } from '../jwt.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';
import { resetOrgOwnerCache } from '../session-ownership.js';
import config from '../config.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('GET /api/sessions/:sessionId/preview/processes', () => {
  it('returns { group: null, processes: [] } when no active preview group exists', async () => {
    const session = await createSession();
    const sessionId = session.id as string;

    const res = await request.get(`/api/sessions/${sessionId}/preview/processes`).expect(200);

    const body = res.body as { group: unknown; processes: unknown[] };
    expect(body.group).toBeNull();
    expect(body.processes).toEqual([]);
  });

  it('returns the documented shape with group and processes when rows exist', async () => {
    const session = await createSession();
    const sessionId = session.id as string;

    const db = getDb();
    const groupId = randomUUID();
    db.prepare(
      `INSERT INTO worktree_preview_groups
         (id, session_id, project_id, status, started_at, last_active_at)
       VALUES (?, ?, 'test-proj', 'ready', datetime('now'), datetime('now'))`,
    ).run(groupId, sessionId);

    const proc1Id = randomUUID();
    const proc2Id = randomUUID();
    db.prepare(
      `INSERT INTO worktree_preview_processes
         (id, group_id, name, pid, port, url, log_path, status, started_at)
       VALUES (?, ?, 'api', 1234, 4101, 'http://localhost:4101', null, 'ready', datetime('now'))`,
    ).run(proc1Id, groupId);
    db.prepare(
      `INSERT INTO worktree_preview_processes
         (id, group_id, name, pid, port, url, log_path, status, started_at)
       VALUES (?, ?, 'web', 5678, 4102, 'http://localhost:4102', null, 'starting', datetime('now', '+1 second'))`,
    ).run(proc2Id, groupId);

    const res = await request.get(`/api/sessions/${sessionId}/preview/processes`).expect(200);

    const body = res.body as {
      group: { id: string; session_id: string; status: string } | null;
      processes: Array<{ id: string; name: string; port: number; status: string }>;
    };

    expect(body.group).not.toBeNull();
    expect(body.group!.id).toBe(groupId);
    expect(body.group!.session_id).toBe(sessionId);
    expect(body.group!.status).toBe('ready');

    expect(body.processes).toHaveLength(2);
    // processes are ordered by started_at ASC, name ASC — api comes first
    expect(body.processes[0].name).toBe('api');
    expect(body.processes[0].port).toBe(4101);
    expect(body.processes[1].name).toBe('web');
    expect(body.processes[1].port).toBe(4102);
  });

  it('selects only the most-recent group by started_at DESC LIMIT 1 when multiple exist', async () => {
    const session = await createSession();
    const sessionId = session.id as string;

    const db = getDb();
    const oldGroupId = randomUUID();
    const newGroupId = randomUUID();

    db.prepare(
      `INSERT INTO worktree_preview_groups
         (id, session_id, project_id, status, started_at, last_active_at)
       VALUES (?, ?, 'test-proj', 'failed', datetime('now', '-10 minutes'), datetime('now', '-10 minutes'))`,
    ).run(oldGroupId, sessionId);
    db.prepare(
      `INSERT INTO worktree_preview_groups
         (id, session_id, project_id, status, started_at, last_active_at)
       VALUES (?, ?, 'test-proj', 'ready', datetime('now'), datetime('now'))`,
    ).run(newGroupId, sessionId);

    const res = await request.get(`/api/sessions/${sessionId}/preview/processes`).expect(200);

    const body = res.body as { group: { id: string } | null; processes: unknown[] };
    expect(body.group!.id).toBe(newGroupId);
  });

  describe('ownership enforcement', () => {
    let authPath = '';
    let ownerToken = '';
    let foreignToken = '';
    let ownedSessionId = '';

    beforeAll(async () => {
      authPath = path.join(config.dataDir, 'auth.json');
      const jwtSecret = generateJwtSecret();
      saveAuthRecord({
        username: 'preview-proc-owner',
        passwordHash: 'scrypt$ignored',
        jwtSecret,
        role: 'Owner',
      });

      const orgId = getActiveOrgId();
      const ownerRow = createUser({
        username: `pp-owner-${Date.now()}`,
        passwordHash: 'h',
        createdAt: '2026-01-01T00:00:00Z',
      });
      const foreignRow = createUser({
        username: `pp-foreign-${Date.now()}`,
        passwordHash: 'h',
        createdAt: '2026-01-02T00:00:00Z',
      });
      createMembership(ownerRow.id, orgId, 'Admin');
      createMembership(foreignRow.id, orgId, 'Admin');
      resetOrgOwnerCache();

      ownerToken = signJwt(ownerRow.username, jwtSecret, {
        expiresInSec: 3600,
        claims: { role: 'Owner', uid: ownerRow.id },
      });
      foreignToken = signJwt(foreignRow.username, jwtSecret, {
        expiresInSec: 3600,
        claims: { role: 'Admin', uid: foreignRow.id },
      });

      // Create project + agent + session as ownerRow so the session has a
      // recorded owner. Use inline requests to carry the auth header —
      // the helpers don't accept a token parameter.
      const projId = `pp-proj-${Date.now()}`;
      await request
        .post('/api/projects')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ id: projId, name: 'PP Test Project', cwd: '/tmp', color: '#3B82F6' })
        .expect(201);
      const agentId = `pp-agent-${Date.now()}`;
      await request
        .post('/api/agents')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ id: agentId, projectId: projId, name: 'PP Test Agent', engine: 'claude-code' })
        .expect(201);
      const sessRes = await request
        .post(`/api/agents/${agentId}/sessions`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'pp-owned-session' })
        .expect(200);
      ownedSessionId = (sessRes.body as { id: string }).id;
    });

    afterAll(() => {
      try {
        if (authPath && existsSync(authPath)) unlinkSync(authPath);
      } catch {
        /* best-effort */
      }
      reloadAuthRecord();
      resetOrgOwnerCache();
    });

    it('non-owner receives 404 with { error: "Session not found" }', async () => {
      const res = await request
        .get(`/api/sessions/${ownedSessionId}/preview/processes`)
        .set('Authorization', `Bearer ${foreignToken}`)
        .expect(404);
      expect((res.body as { error: string }).error).toBe('Session not found');
    });

    it('owner receives 200 with empty-state shape', async () => {
      const res = await request
        .get(`/api/sessions/${ownedSessionId}/preview/processes`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      const body = res.body as { group: unknown; processes: unknown[] };
      expect(body.group).toBeNull();
      expect(body.processes).toEqual([]);
    });
  });
});
