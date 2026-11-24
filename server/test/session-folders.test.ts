/**
 * Per-user session folders: CRUD, filing, and isolation between users.
 */

import './setup.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import supertest from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
import { createProject, createAgent, createSession, getRequest } from './helpers.js';
import type { RouteDeps } from '../types.js';

let request: supertest.Agent;
let agentId: string;
let otherAgentId: string;

beforeAll(async () => {
  await getRequest();
  const createSessionFolderRoutes = (await import('../routes/session-folders.js')).default;
  const { getStmts } = await import('../db.js');
  const { findAgent } = await import('../project-model.js');
  const app = express();
  app.use(express.json());
  // Stand-in for the auth middleware: `x-test-user` becomes `authUserId`.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const user = req.header('x-test-user');
    if (user) (req as unknown as { authUserId?: string }).authUserId = user;
    next();
  });
  app.use(createSessionFolderRoutes({ stmts: getStmts(), findAgent } as unknown as RouteDeps));
  request = supertest.agent(app);
  const project = await createProject({ id: 'session-folder-proj', name: 'Folders', cwd: '/tmp' });
  agentId = (
    await createAgent({ projectId: project.id as string, id: 'sf-agent', name: 'SF Agent' })
  ).id as string;
  otherAgentId = (
    await createAgent({ projectId: project.id as string, id: 'sf-agent-2', name: 'SF Agent 2' })
  ).id as string;
});

const as = (user: string) => ({ 'x-test-user': user });

describe('session folders', () => {
  it('creates, renames, files a session, and deletes without losing the session', async () => {
    const session = await createSession({ agentId, name: 'Filed' });
    const sessionId = session.id as string;

    const a = await request
      .post(`/api/agents/${agentId}/session-folders`)
      .set(as('alice'))
      .send({ name: '  Infra  ' })
      .expect(201);
    expect(a.body.folder).toMatchObject({ name: 'Infra', agentId, position: 0 });
    const b = await request
      .post(`/api/agents/${agentId}/session-folders`)
      .set(as('alice'))
      .send({ name: 'Bugs' })
      .expect(201);
    expect(b.body.folder.position).toBe(1);

    await request
      .patch(`/api/session-folders/${a.body.folder.id}`)
      .set(as('alice'))
      .send({ name: 'Platform' })
      .expect(200);

    await request
      .put(`/api/sessions/${sessionId}/folder`)
      .set(as('alice'))
      .send({ folderId: a.body.folder.id })
      .expect(200);

    let list = await request.get(`/api/agents/${agentId}/session-folders`).set(as('alice'));
    expect(list.body.folders.map((f: { name: string }) => f.name)).toEqual(['Platform', 'Bugs']);
    expect(list.body.assignments).toEqual({ [sessionId]: a.body.folder.id });

    // Moving re-files rather than duplicating.
    await request
      .put(`/api/sessions/${sessionId}/folder`)
      .set(as('alice'))
      .send({ folderId: b.body.folder.id })
      .expect(200);
    list = await request.get(`/api/agents/${agentId}/session-folders`).set(as('alice'));
    expect(list.body.assignments).toEqual({ [sessionId]: b.body.folder.id });

    await request.delete(`/api/session-folders/${b.body.folder.id}`).set(as('alice')).expect(200);
    list = await request.get(`/api/agents/${agentId}/session-folders`).set(as('alice'));
    expect(list.body.folders).toHaveLength(1);
    expect(list.body.assignments).toEqual({});

    // Unfile explicitly.
    await request
      .put(`/api/sessions/${sessionId}/folder`)
      .set(as('alice'))
      .send({ folderId: a.body.folder.id })
      .expect(200);
    await request
      .put(`/api/sessions/${sessionId}/folder`)
      .set(as('alice'))
      .send({ folderId: null })
      .expect(200);
    list = await request.get(`/api/agents/${agentId}/session-folders`).set(as('alice'));
    expect(list.body.assignments).toEqual({});
  });

  it("keeps one user's folders and filing invisible to another user", async () => {
    const session = await createSession({ agentId, name: 'Shared view' });
    const sessionId = session.id as string;
    const folder = await request
      .post(`/api/agents/${agentId}/session-folders`)
      .set(as('carol'))
      .send({ name: 'Mine' })
      .expect(201);
    await request
      .put(`/api/sessions/${sessionId}/folder`)
      .set(as('carol'))
      .send({ folderId: folder.body.folder.id })
      .expect(200);

    const dave = await request.get(`/api/agents/${agentId}/session-folders`).set(as('dave'));
    expect(dave.body).toEqual({ folders: [], assignments: {} });

    // Dave cannot rename, delete, or file into Carol's folder.
    const id = folder.body.folder.id;
    await request
      .patch(`/api/session-folders/${id}`)
      .set(as('dave'))
      .send({ name: 'x' })
      .expect(404);
    await request.delete(`/api/session-folders/${id}`).set(as('dave')).expect(404);
    await request
      .put(`/api/sessions/${sessionId}/folder`)
      .set(as('dave'))
      .send({ folderId: id })
      .expect(404);
  });

  it("rejects filing a session into another agent's folder", async () => {
    const session = await createSession({ agentId, name: 'Wrong agent' });
    const folder = await request
      .post(`/api/agents/${otherAgentId}/session-folders`)
      .set(as('erin'))
      .send({ name: 'Elsewhere' })
      .expect(201);
    await request
      .put(`/api/sessions/${session.id as string}/folder`)
      .set(as('erin'))
      .send({ folderId: folder.body.folder.id })
      .expect(404);
  });

  it('validates names and unknown targets', async () => {
    await request
      .post(`/api/agents/${agentId}/session-folders`)
      .set(as('frank'))
      .send({ name: '   ' })
      .expect(400);
    await request
      .post(`/api/agents/${agentId}/session-folders`)
      .set(as('frank'))
      .send({ name: 'x'.repeat(81) })
      .expect(400);
    await request.get('/api/agents/no-such-agent/session-folders').expect(404);
    await request.put('/api/sessions/no-such-session/folder').send({ folderId: null }).expect(404);
  });
});
