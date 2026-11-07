/**
 * Idempotency-Key on POST /api/agents/:agentId/sessions: a client that lost
 * the response (or crashed before recording success) retries with the same
 * key and gets the original session back, with no second session and no
 * second auto-started turn.
 */

import './setup.js';
import express from 'express';
import supertest from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createProject, createAgent, getRequest } from './helpers.js';
import type { RouteDeps } from '../types.js';

const handleChat = vi.fn((_ws: unknown, _msg: unknown) => Promise.resolve());
// Kicks the durable message queue. A no-op here is the same as the process
// dying right after the create committed: nothing ran the queued prompt yet.
const drainSessionQueue = vi.fn((_sessionId: string) => {});
let request: supertest.Agent;
let agentId: string;

function sessionCount(): number {
  return (
    getDbRef().prepare('SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ?').get(agentId) as {
      n: number;
    }
  ).n;
}
let getDbRef: () => import('better-sqlite3').Database;

beforeAll(async () => {
  await getRequest();
  const createSessionRoutes = (await import('../routes/sessions.js')).default;
  const { getStmts, getDb } = await import('../db.js');
  getDbRef = getDb;
  const { findAgent, findProject, getEnrichedAgent } = await import('../project-model.js');
  const app = express();
  app.use(express.json());
  app.use(
    createSessionRoutes({
      stmts: getStmts(),
      findAgent,
      findProject,
      getEnrichedAgent,
      handleChat,
      drainSessionQueue,
      broadcast: () => {},
      activeProcesses: new Map(),
      config: { engineValidModels: {}, engineDefaultModels: {} },
    } as unknown as RouteDeps),
  );
  request = supertest.agent(app);
  const project = await createProject({ id: 'idem-proj', name: 'Idem', cwd: '/tmp' });
  const agent = await createAgent({
    projectId: project.id as string,
    id: 'idem-agent',
    name: 'Idem',
  });
  agentId = agent.id as string;
});

beforeEach(() => {
  handleChat.mockClear();
  drainSessionQueue.mockClear();
});

const body = { name: 'From WoW', seedMessage: 'fix the test', autoStart: true, autoTitle: true };

describe('POST /api/agents/:agentId/sessions with Idempotency-Key', () => {
  it('replays the first session when the response was lost and the client retries', async () => {
    const before = sessionCount();
    // First attempt: the server accepts; pretend the client never saw the response.
    const first = await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Idempotency-Key', 'wow-retry-1')
      .send(body)
      .expect(200);
    const retry = await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Idempotency-Key', 'wow-retry-1')
      .send(body)
      .expect(200);

    expect(retry.body.id).toBe(first.body.id);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(sessionCount()).toBe(before + 1);
    // The prompt is queued with the session and kicked once, not per attempt.
    expect(drainSessionQueue).toHaveBeenCalledTimes(1);
    expect(drainSessionQueue).toHaveBeenCalledWith(first.body.id);
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('still creates a new session per distinct key, and without a key', async () => {
    const a = await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Idempotency-Key', 'wow-a')
      .send(body);
    const b = await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Idempotency-Key', 'wow-b')
      .send(body);
    const c = await request.post(`/api/agents/${agentId}/sessions`).send(body);
    const d = await request.post(`/api/agents/${agentId}/sessions`).send(body);
    expect(new Set([a.body.id, b.body.id, c.body.id, d.body.id]).size).toBe(4);
  });

  it('rejects a reused key with a different body, and a malformed key', async () => {
    await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Idempotency-Key', 'wow-mismatch')
      .send(body)
      .expect(200);
    await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Idempotency-Key', 'wow-mismatch')
      .send({ ...body, seedMessage: 'something else' })
      .expect(422);
    await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Idempotency-Key', 'has spaces!')
      .send(body)
      .expect(400);
  });

  it('reports 409 when the original session was deleted', async () => {
    const first = await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Idempotency-Key', 'wow-deleted')
      .send(body)
      .expect(200);
    getDbRef()
      .prepare("UPDATE sessions SET deleted_at = datetime('now') WHERE id = ?")
      .run(first.body.id);
    await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Idempotency-Key', 'wow-deleted')
      .send(body)
      .expect(409);
  });

  it('delivers the prompt after a crash between commit and dispatch', async () => {
    const { getStmts } = await import('../db.js');
    const { drainIdleQueuedSessions } = await import('../session-chat-busy.js');
    const created = await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Idempotency-Key', 'wow-crash')
      .send(body)
      .expect(200);
    const id = created.body.id as string;

    // The prompt committed with the session: stored and still queued.
    const messages = getStmts().getMessages.all(id) as Array<{ role: string; content: string }>;
    expect(messages.map((m) => [m.role, m.content])).toEqual([['user', 'fix the test']]);
    expect(getStmts().getQueuedMessages.all(id)).toHaveLength(1);

    // The client retries; it gets the same session, nothing new is queued.
    const retry = await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Idempotency-Key', 'wow-crash')
      .send(body)
      .expect(200);
    expect(retry.body.id).toBe(id);
    expect(getStmts().getQueuedMessages.all(id)).toHaveLength(1);

    // Boot (and the periodic sweep) drain idle queues, which runs the prompt.
    const drainQueue = vi.fn();
    drainIdleQueuedSessions({ stmts: getStmts(), activeProcesses: new Map(), drainQueue });
    expect(drainQueue).toHaveBeenCalledWith(id);
  });
});
