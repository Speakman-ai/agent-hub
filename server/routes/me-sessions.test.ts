import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, getStmts, initDb } from '../db.js';
import type { Agent, AgentLookup, ChatMessage, Project, RouteDeps } from '../types.js';
import { initOrgsDb, setOrgsDbPathForTests } from '../orgs.js';
import { reloadAuthRecord, saveAuthRecord, setAuthFilePathForTests } from '../auth-store.js';
import createMeSessionsRoutes, { type MeSessionsRouteOptions } from './me-sessions.js';

// Stands in for chat.ts: stores the user message under `_userMessageId` and
// reports it persisted, as the real handler does before the turn runs.
async function storingHandler(_ws: unknown, msg: ChatMessage) {
  const id = msg._userMessageId ?? `m-${Math.random()}`;
  getDb()
    .prepare("INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, 'user', ?)")
    .run(id, msg.sessionId, msg.content);
  msg._onUserMessagePersisted?.(true);
}
const handleChat = vi.fn(storingHandler);

const projects: Record<string, Project> = {
  mine: { id: 'mine', name: 'Mine', cwd: '/tmp/m', ahw: '/tmp/m' } as Project,
  secret: {
    id: 'secret',
    name: 'Secret',
    cwd: '/tmp/s',
    ahw: '/tmp/s',
    visibility: 'private',
    ownerUserId: 'user-2',
  } as Project,
};
const agents: Record<string, AgentLookup> = {
  dev: { project: projects.mine, agent: { id: 'dev', name: 'Dev' } as Agent },
  spy: { project: projects.secret, agent: { id: 'spy', name: 'Spy' } as Agent },
};

function mount(userId: string, options: MeSessionsRouteOptions = {}): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    Object.assign(req, { authUserId: userId, authRole: 'User' });
    next();
  });
  app.use(
    createMeSessionsRoutes(
      {
        stmts: getStmts(),
        handleChat,
        activeProcesses: new Map(),
        findAgent: (id: string) => agents[id] ?? null,
        getProjects: () => Object.values(projects),
        config: {},
      } as unknown as RouteDeps,
      options,
    ),
  );
  return app;
}

function seedSession(opts: {
  id: string;
  agentId: string;
  owner: string;
  updatedAt: string;
  extraSql?: string;
}) {
  getStmts().createSession.run(
    opts.id,
    opts.agentId,
    `Session ${opts.id}`,
    'claude-code',
    'sonnet',
    0,
    0,
    1,
  );
  getDb()
    .prepare(
      `UPDATE sessions SET owner_user_id = ?, updated_at = ? ${opts.extraSql ?? ''} WHERE id = ?`,
    )
    .run(opts.owner, opts.updatedAt, opts.id);
}

function seedMessage(sessionId: string, role: string, content: string, at: string) {
  getDb()
    .prepare(
      'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(`${sessionId}-${at}`, sessionId, role, content, at);
}

beforeAll(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ah-me-sessions-'));
  initDb(dir);
  // The project visibility gate reads the assignment ACL from orgs.db.
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  // Per-user auth is set up, so session ownership is enforced strictly.
  setAuthFilePathForTests(path.join(dir, 'auth.json'));
  saveAuthRecord({ username: 'owner', passwordHash: 'x', role: 'Owner', jwtSecret: 'test-secret' });
  reloadAuthRecord();
});

beforeEach(() => {
  handleChat.mockReset();
  handleChat.mockImplementation(storingHandler);
  const db = getDb();
  db.exec('DELETE FROM messages');
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM request_idempotency');
});

describe('GET /api/me/sessions/recent', () => {
  it("lists only the caller's visible sessions, newest first, with the latest reply", async () => {
    seedSession({ id: 'old', agentId: 'dev', owner: 'user-1', updatedAt: '2026-11-01 10:00:00' });
    seedSession({ id: 'new', agentId: 'dev', owner: 'user-1', updatedAt: '2026-11-07 10:00:00' });
    seedSession({
      id: 'theirs',
      agentId: 'dev',
      owner: 'user-2',
      updatedAt: '2026-11-07 11:00:00',
    });
    seedSession({
      id: 'private',
      agentId: 'spy',
      owner: 'user-1',
      updatedAt: '2026-11-07 12:00:00',
    });
    seedSession({
      id: 'archived',
      agentId: 'dev',
      owner: 'user-1',
      updatedAt: '2026-11-07 13:00:00',
      extraSql: ", deleted_at = '2026-11-07 13:00:00'",
    });
    seedMessage('new', 'user', 'fix the test', '2026-11-07 09:00:00');
    seedMessage('new', 'assistant', 'x'.repeat(100), '2026-11-07 09:01:00');
    seedMessage('new', 'system', 'internal', '2026-11-07 09:02:00');

    const res = await request(mount('user-1'))
      .get('/api/me/sessions/recent?messages=5&maxChars=50')
      .expect(200);

    expect(res.body.sessions.map((s: { id: string }) => s.id)).toEqual(['new', 'old']);
    const [first] = res.body.sessions;
    expect(first).toMatchObject({
      agentId: 'dev',
      agentName: 'Dev',
      projectName: 'Mine',
      name: 'Session new',
    });
    expect(typeof first.state).toBe('string');
    expect(first.lastReply).toHaveLength(50);
    expect(first.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(res.body.sessions[1]).toMatchObject({ lastReply: null, messages: [] });
  });

  it('honours limit and rejects a bad query', async () => {
    for (let i = 0; i < 3; i++) {
      seedSession({
        id: `s${i}`,
        agentId: 'dev',
        owner: 'user-1',
        updatedAt: `2026-11-0${i + 1} 10:00:00`,
      });
    }
    const res = await request(mount('user-1')).get('/api/me/sessions/recent?limit=2').expect(200);
    expect(res.body.sessions.map((s: { id: string }) => s.id)).toEqual(['s2', 's1']);
    await request(mount('user-1')).get('/api/me/sessions/recent?limit=999').expect(400);
  });
});

describe('POST /api/me/sessions/:sessionId/reply', () => {
  it('runs the message as the next turn', async () => {
    seedSession({ id: 'mine', agentId: 'dev', owner: 'user-1', updatedAt: '2026-11-07 10:00:00' });
    const res = await request(mount('user-1'))
      .post('/api/me/sessions/mine/reply')
      .send({ content: '  ship it  ' })
      .expect(202);
    expect(res.body).toEqual({ sessionId: 'mine', queued: false });
    expect(handleChat).toHaveBeenCalledWith(null, {
      type: 'chat',
      agentId: 'dev',
      sessionId: 'mine',
      content: 'ship it',
      _userMessageId: expect.any(String),
      _onUserMessagePersisted: expect.any(Function),
    });
  });

  it("404s on someone else's session and on an unknown one", async () => {
    seedSession({
      id: 'theirs',
      agentId: 'dev',
      owner: 'user-2',
      updatedAt: '2026-11-07 10:00:00',
    });
    await request(mount('user-1'))
      .post('/api/me/sessions/theirs/reply')
      .send({ content: 'hi' })
      .expect(404);
    await request(mount('user-1'))
      .post('/api/me/sessions/nope/reply')
      .send({ content: 'hi' })
      .expect(404);
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('runs a retried reply once when it carries the same Idempotency-Key', async () => {
    seedSession({ id: 'mine', agentId: 'dev', owner: 'user-1', updatedAt: '2026-11-07 10:00:00' });
    const app = mount('user-1');
    const send = (content: string) =>
      request(app)
        .post('/api/me/sessions/mine/reply')
        .set('Idempotency-Key', 'wow-reply-1')
        .send({ content });
    // The first response is treated as lost; the client retries.
    expect((await send('ship it')).status).toBe(202);
    const retry = await send('ship it');
    expect(retry.status).toBe(202);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(handleChat).toHaveBeenCalledTimes(1);

    expect((await send('something else')).status).toBe(422);
    expect(handleChat).toHaveBeenCalledTimes(1);
  });

  it('reports failure and lets the same key run again when the handler rejects before storing', async () => {
    seedSession({ id: 'mine', agentId: 'dev', owner: 'user-1', updatedAt: '2026-11-07 10:00:00' });
    const app = mount('user-1');
    const send = () =>
      request(app)
        .post('/api/me/sessions/mine/reply')
        .set('Idempotency-Key', 'wow-fail-1')
        .send({ content: 'ship it' });

    handleChat.mockImplementationOnce(async () => {
      throw new Error('spawn failed');
    });
    const failed = await send();
    expect(failed.status).toBe(503);

    const retry = await send();
    expect(retry.status).toBe(202);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(handleChat).toHaveBeenCalledTimes(2);
    const stored = getDb()
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = 'mine'")
      .get() as { n: number };
    expect(stored.n).toBe(1);
  });

  it('treats a handler that declines the message as not accepted', async () => {
    seedSession({ id: 'mine', agentId: 'dev', owner: 'user-1', updatedAt: '2026-11-07 10:00:00' });
    handleChat.mockImplementationOnce(async (_ws, msg) => msg._onUserMessagePersisted?.(false));
    await request(mount('user-1'))
      .post('/api/me/sessions/mine/reply')
      .set('Idempotency-Key', 'wow-declined')
      .send({ content: 'hi' })
      .expect(503);
    await request(mount('user-1'))
      .post('/api/me/sessions/mine/reply')
      .set('Idempotency-Key', 'wow-declined')
      .send({ content: 'hi' })
      .expect(202);
    expect(handleChat).toHaveBeenCalledTimes(2);
  });

  it('never dispatches twice while a timed-out dispatch can still store its message', async () => {
    seedSession({ id: 'mine', agentId: 'dev', owner: 'user-1', updatedAt: '2026-11-07 10:00:00' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Slow handler: stores and reports only after the request has timed out.
    handleChat.mockImplementationOnce(async (ws, msg) => {
      await gate;
      await storingHandler(ws, msg);
    });
    const app = mount('user-1', { acceptTimeoutMs: 20 });
    const send = () =>
      request(app)
        .post('/api/me/sessions/mine/reply')
        .set('Idempotency-Key', 'wow-slow')
        .send({ content: 'ship it' });

    const timedOut = await send();
    expect(timedOut.status).toBe(503);
    expect(timedOut.headers['retry-after']).toBe('30');

    // Retry while the first dispatch is still running: no second dispatch.
    expect((await send()).status).toBe(503);
    expect(handleChat).toHaveBeenCalledTimes(1);

    // The first dispatch stores late; the retry now replays it.
    release();
    await vi.waitFor(() => {
      const n = getDb()
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = 'mine'")
        .get() as { n: number };
      expect(n.n).toBe(1);
    });
    const replay = await send();
    expect(replay.status).toBe(202);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(handleChat).toHaveBeenCalledTimes(1);
    const total = getDb()
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = 'mine'")
      .get() as { n: number };
    expect(total.n).toBe(1);
  });

  it('reruns a key whose message never landed when no dispatch is running (server restarted)', async () => {
    seedSession({ id: 'mine', agentId: 'dev', owner: 'user-1', updatedAt: '2026-11-07 10:00:00' });
    const { payloadHash, recordIdempotent } = await import('../request-idempotency.js');
    // Left behind by a process that died after recording the key.
    recordIdempotent(
      'user-1',
      'POST /api/me/sessions/:sessionId/reply',
      'wow-orphan',
      payloadHash({ sessionId: 'mine', content: 'hi' }),
      'mine',
      'never-stored',
    );
    const send = () =>
      request(mount('user-1'))
        .post('/api/me/sessions/mine/reply')
        .set('Idempotency-Key', 'wow-orphan')
        .send({ content: 'hi' });
    expect((await send()).status).toBe(202);
    expect(handleChat).toHaveBeenCalledTimes(1);
    expect((await send()).headers['idempotent-replayed']).toBe('true');
    expect(handleChat).toHaveBeenCalledTimes(1);
  });

  it('keeps keys per user', async () => {
    seedSession({ id: 'a1', agentId: 'dev', owner: 'user-1', updatedAt: '2026-11-07 10:00:00' });
    seedSession({ id: 'b1', agentId: 'dev', owner: 'user-3', updatedAt: '2026-11-07 10:00:00' });
    await request(mount('user-1'))
      .post('/api/me/sessions/a1/reply')
      .set('Idempotency-Key', 'shared-key')
      .send({ content: 'hi' })
      .expect(202);
    const other = await request(mount('user-3'))
      .post('/api/me/sessions/b1/reply')
      .set('Idempotency-Key', 'shared-key')
      .send({ content: 'hi' })
      .expect(202);
    expect(other.headers['idempotent-replayed']).toBeUndefined();
    expect(handleChat).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty message', async () => {
    seedSession({ id: 'mine', agentId: 'dev', owner: 'user-1', updatedAt: '2026-11-07 10:00:00' });
    await request(mount('user-1'))
      .post('/api/me/sessions/mine/reply')
      .send({ content: '   ' })
      .expect(400);
    expect(handleChat).not.toHaveBeenCalled();
  });
});
