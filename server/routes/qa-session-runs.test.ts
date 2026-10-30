import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, getStmts, initDb } from '../db.js';
import { createQaEnvironment } from '../qa-environments.js';
import { __testResetQaSessionRuns } from '../qa-session-runs.js';
import type { Project, RouteDeps } from '../types.js';
import createQaSessionRunRoutes from './qa-session-runs.js';

const project = {
  id: 'proj',
  name: 'Proj',
  cwd: '/tmp/proj',
  ahw: '/tmp/ahw',
  agents: [
    { id: 'dev', name: 'Dev', role: 'dev' },
    { id: 'qa', name: 'QA', role: 'qa' },
  ],
} as unknown as Project;
const broadcast = vi.fn();
let app: Express;
let sessionId: string;

beforeAll(() => {
  initDb(mkdtempSync(path.join(tmpdir(), 'ah-qa-session-routes-')));
  app = express();
  app.use(express.json());
  app.use(
    createQaSessionRunRoutes({
      broadcast,
      stmts: getStmts(),
      findProject: (id: string) => (id === 'proj' ? project : null),
      findAgent: (id: string) =>
        project.agents.find((a) => a.id === id) ? { project, agent: { id } } : null,
      handleChat: vi.fn(),
      config: {},
    } as unknown as RouteDeps),
  );
});

beforeEach(() => {
  __testResetQaSessionRuns();
  getDb().exec('DELETE FROM qa_session_requests');
  getDb().exec('DELETE FROM qa_environments');
  sessionId = randomUUID();
  getStmts().createSession.run(sessionId, 'dev', 'Work', 'claude-code', 'sonnet', 1, 0, 1);
});

describe('session QA request routes', () => {
  it('reports state with no request', async () => {
    const res = await request(app).get(`/api/sessions/${sessionId}/qa-request`).expect(200);
    expect(res.body).toMatchObject({
      request: null,
      merged: false,
      defaultEnvironment: null,
      delayMinutes: 0,
      hasQaAgent: true,
    });
  });

  it('refuses to arm without a default environment, then arms', async () => {
    const url = `/api/sessions/${sessionId}/qa-request`;
    const refused = await request(app).put(url).send({ armed: true }).expect(409);
    expect(refused.body.code).toBe('no_default_environment');
    createQaEnvironment('proj', {
      name: 'Staging',
      baseUrl: 'https://s.example.com',
      isDefault: true,
    });
    const armed = await request(app).put(url).send({ armed: true }).expect(200);
    expect(armed.body.request.status).toBe('armed');
    expect(armed.body.defaultEnvironment.name).toBe('Staging');
    const unarmed = await request(app).put(url).send({ armed: false }).expect(200);
    expect(unarmed.body.request).toBeNull();
    await request(app).put(url).send({ armed: 'yes' }).expect(400);
  });

  it('404s an unknown session', async () => {
    await request(app).get('/api/sessions/nope/qa-request').expect(404);
    await request(app).post('/api/sessions/nope/qa-request/run').expect(404);
  });

  it('refuses /run for a session that has not merged', async () => {
    createQaEnvironment('proj', {
      name: 'Staging',
      baseUrl: 'https://s.example.com',
      isDefault: true,
    });
    getDb()
      .prepare('UPDATE sessions SET worktree_branch = ? WHERE id = ?')
      .run(`agent-hub/dev/session-${sessionId.slice(0, 8)}`, sessionId);
    const res = await request(app).post(`/api/sessions/${sessionId}/qa-request/run`).expect(409);
    expect(res.body.code).toBe('not_merged');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM qa_plans').get()).toEqual({ n: 0 });
    const state = await request(app).get(`/api/sessions/${sessionId}/qa-request`).expect(200);
    expect(state.body.request).toBeNull();
    expect(state.body.merged).toBe(false);
  });
});
