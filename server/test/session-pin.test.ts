/**
 * `pinned` on PATCH /api/sessions/:sessionId pins a session to the top of its
 * agent's session list without counting as activity.
 */

import './setup.js';
import express from 'express';
import supertest from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
import { createProject, createAgent, getRequest } from './helpers.js';
import type { RouteDeps } from '../types.js';

let request: supertest.Agent;
let agentId: string;
let setUpdatedAt: (id: string, at: string) => void;
let readUpdatedAt: (id: string) => string;

beforeAll(async () => {
  await getRequest();
  const createSessionRoutes = (await import('../routes/sessions.js')).default;
  const { getStmts, getDb } = await import('../db.js');
  const { findAgent, findProject, getEnrichedAgent } = await import('../project-model.js');
  const app = express();
  app.use(express.json());
  app.use(
    createSessionRoutes({
      stmts: getStmts(),
      findAgent,
      findProject,
      getEnrichedAgent,
      broadcast: () => {},
      activeProcesses: new Map(),
      config: { engineValidModels: {}, engineDefaultModels: {} },
    } as unknown as RouteDeps),
  );
  request = supertest.agent(app);
  setUpdatedAt = (id, at) =>
    getDb().prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(at, id);
  readUpdatedAt = (id) =>
    (
      getDb().prepare('SELECT updated_at FROM sessions WHERE id = ?').get(id) as {
        updated_at: string;
      }
    ).updated_at;
  const project = await createProject({ id: 'session-pin-proj', name: 'Pin', cwd: '/tmp' });
  const agent = await createAgent({
    projectId: project.id as string,
    id: 'session-pin-agent',
    name: 'Pin Agent',
  });
  agentId = agent.id as string;
});

async function listIds(): Promise<string[]> {
  const res = await request.get(`/api/agents/${agentId}/sessions`).expect(200);
  return (res.body as Array<{ id: string }>).map((s) => s.id);
}

describe('PATCH /api/sessions/:sessionId pinned', () => {
  it('lists pinned sessions first and unpinning restores recency order', async () => {
    const ids: string[] = [];
    for (const name of ['Oldest', 'Middle', 'Newest']) {
      const res = await request.post(`/api/agents/${agentId}/sessions`).send({ name }).expect(200);
      ids.push(res.body.id);
    }
    const [oldest, middle, newest] = ids;
    setUpdatedAt(oldest, '2026-01-01 00:00:00');
    setUpdatedAt(middle, '2026-01-02 00:00:00');
    setUpdatedAt(newest, '2026-01-03 00:00:00');
    expect(await listIds()).toEqual([newest, middle, oldest]);

    const pinned = await request
      .patch(`/api/sessions/${oldest}`)
      .send({ pinned: true })
      .expect(200);
    expect(pinned.body.pinned_at).toEqual(expect.any(String));
    expect(await listIds()).toEqual([oldest, newest, middle]);
    // A pin is not activity.
    expect(readUpdatedAt(oldest)).toBe('2026-01-01 00:00:00');

    // Re-pinning keeps the original pin time.
    const again = await request.patch(`/api/sessions/${oldest}`).send({ pinned: true }).expect(200);
    expect(again.body.pinned_at).toBe(pinned.body.pinned_at);

    const unpinned = await request
      .patch(`/api/sessions/${oldest}`)
      .send({ pinned: false })
      .expect(200);
    expect(unpinned.body.pinned_at).toBeNull();
    expect(await listIds()).toEqual([newest, middle, oldest]);
  });

  it('rejects a non-boolean pinned value', async () => {
    const res = await request.post(`/api/agents/${agentId}/sessions`).send({ name: 'X' });
    await request.patch(`/api/sessions/${res.body.id}`).send({ pinned: 'yes' }).expect(400);
  });
});
