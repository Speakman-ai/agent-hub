/**
 * POST /api/projects/:projectId/sessions/dispatch — the route the Hub
 * assistant (and `sessions.sh dispatch`) uses to start a session on a project
 * agent. Dispatch itself is mocked; no CLI is spawned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import type { Project, RouteDeps } from '../types.js';
import { HUB_PROJECT_ID } from '../../shared/utils/hub.js';

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock('../background-agent-session.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../background-agent-session.js')>();
  return { ...real, dispatchBackgroundAgentSession: mocks.dispatch };
});

const { BackgroundSessionDispatchError } = await import('../background-agent-session.js');
const { default: createSessionDispatchRoutes, sessionNameFromPrompt } =
  await import('./session-dispatch.js');

const project = {
  id: 'web',
  name: 'Web',
  cwd: '/tmp/web',
  agents: [
    { id: 'web-dev', name: 'Web Dev', role: 'dev', engine: 'claude-code' },
    { id: 'docs', name: 'Docs', role: 'docs', engine: 'claude-code' },
    { id: 'writer', name: 'Writer', role: 'sub', engine: 'claude-code', isDev: false },
  ],
} as unknown as Project;
const hubProject = {
  id: HUB_PROJECT_ID,
  name: 'Hub',
  kind: 'system',
  agents: [],
} as unknown as Project;

const sessions: Record<
  string,
  { id: string; owner_user_id: string | null; session_mode?: string; deleted_at?: string | null }
> = {
  'hub-sess': { id: 'hub-sess', owner_user_id: 'owner-1' },
  'orch-sess': { id: 'orch-sess', owner_user_id: 'owner-1', session_mode: 'orchestrate' },
  'orch-archived': {
    id: 'orch-archived',
    owner_user_id: 'owner-1',
    session_mode: 'orchestrate',
    deleted_at: '2026-11-17 10:00:00',
  },
  'orch-mine': { id: 'orch-mine', owner_user_id: 'user-1', session_mode: 'orchestrate' },
};

function mount(auth: Record<string, unknown>): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    Object.assign(req, auth);
    next();
  });
  app.use(
    createSessionDispatchRoutes({
      findProject: (id: string) =>
        id === 'web' ? project : id === HUB_PROJECT_ID ? hubProject : null,
      stmts: { getSession: { get: (id: string) => sessions[id] } },
    } as unknown as RouteDeps),
  );
  return app;
}

const asUser = { authUserId: 'user-1', authUser: 'alice', authRole: 'Owner' };
const asGlobalKey = { authViaApiKey: true, authRole: 'Owner' };
const asOwner = { authUserId: 'owner-1', authUser: 'olive', authRole: 'Owner' };

beforeEach(() => {
  mocks.dispatch.mockReset();
  mocks.dispatch.mockImplementation((_project: unknown, cfg: { sessionMode?: string | null }) => ({
    sessionId: 'new-sess',
    agentId: 'web-dev',
    mode: cfg.sessionMode ?? 'manual',
    skippedSkills: [],
  }));
});

describe('POST /api/projects/:projectId/sessions/dispatch', () => {
  it('starts a session owned by the caller and returns a session ref token', async () => {
    const res = await request(mount(asUser))
      .post('/api/projects/web/sessions/dispatch')
      .send({
        prompt: 'Fix the login redirect\nDetails follow',
        agentId: 'web-dev',
        mode: 'review',
      })
      .expect(201);

    expect(res.body).toEqual({
      sessionId: 'new-sess',
      agentId: 'web-dev',
      projectId: 'web',
      name: 'Fix the login redirect',
      mode: 'review',
      skippedSkills: [],
      ref: '@[Fix the login redirect](session:new-sess)',
    });
    const [proj, cfg, opts] = mocks.dispatch.mock.calls[0]!;
    expect(proj).toBe(project);
    expect(cfg).toMatchObject({
      prompt: 'Fix the login redirect\nDetails follow',
      ownerUserId: 'user-1',
      sessionAgentId: 'web-dev',
      sessionMode: 'review',
      runAsSession: true,
    });
    expect(opts).toEqual({ sessionName: 'Fix the login redirect' });
  });

  it('runs as the calling session owner on the global key (the Hub assistant path)', async () => {
    await request(mount(asGlobalKey))
      .post('/api/projects/web/sessions/dispatch')
      .set('X-Agent-Hub-Session-Id', 'hub-sess')
      .send({ prompt: 'Triage', name: 'Triage run' })
      .expect(201);
    const [, cfg, opts] = mocks.dispatch.mock.calls[0]!;
    expect(cfg.ownerUserId).toBe('owner-1');
    expect(opts).toEqual({ sessionName: 'Triage run' });
  });

  it('links the worker to the calling Orchestrate session', async () => {
    await request(mount(asOwner))
      .post('/api/projects/web/sessions/dispatch')
      .set('X-Agent-Hub-Session-Id', 'orch-sess')
      .send({ prompt: 'Rename the park', name: 'Rename code to World Park' })
      .expect(201);
    const [, cfg, opts] = mocks.dispatch.mock.calls[0]!;
    expect(cfg.sessionAgentId).toBe('web-dev');
    expect(opts).toEqual({
      sessionName: 'Rename code to World Park',
      spawnedFromSessionId: 'orch-sess',
    });
  });

  it("refuses to link a worker under another user's Orchestrate session", async () => {
    const res = await request(mount(asUser))
      .post('/api/projects/web/sessions/dispatch')
      .set('X-Agent-Hub-Session-Id', 'orch-sess')
      .send({ prompt: 'Rename the park' })
      .expect(403);
    expect(res.body.code).toBe('parent_session_forbidden');
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('refuses to link a worker under an archived Orchestrate session', async () => {
    const res = await request(mount(asOwner))
      .post('/api/projects/web/sessions/dispatch')
      .set('X-Agent-Hub-Session-Id', 'orch-archived')
      .send({ prompt: 'Rename the park' })
      .expect(409);
    expect(res.body.code).toBe('parent_session_archived');
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('prefers the spawn-bound session over the header when picking the parent', async () => {
    await request(mount({ ...asUser, authSpawnSessionId: 'orch-mine' }))
      .post('/api/projects/web/sessions/dispatch')
      .set('X-Agent-Hub-Session-Id', 'orch-sess')
      .send({ prompt: 'Rename the park', name: 'Rename' })
      .expect(201);
    const [, , opts] = mocks.dispatch.mock.calls[0]!;
    expect(opts).toEqual({ sessionName: 'Rename', spawnedFromSessionId: 'orch-mine' });
  });

  it('rejects an Orchestrate forward onto an agent that is not marked Dev', async () => {
    const docs = await request(mount(asOwner))
      .post('/api/projects/web/sessions/dispatch')
      .set('X-Agent-Hub-Session-Id', 'orch-sess')
      .send({ prompt: 'Seed the wiki', agentId: 'docs' })
      .expect(400);
    expect(docs.body).toEqual({
      error: 'Agent "docs" is not marked as Dev',
      code: 'no_session_agent',
    });
    const writer = await request(mount(asOwner))
      .post('/api/projects/web/sessions/dispatch')
      .set('X-Agent-Hub-Session-Id', 'orch-sess')
      .send({ prompt: 'Write copy', agentId: 'writer' })
      .expect(400);
    expect(writer.body.error).toBe('Agent "writer" is not marked as Dev');
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('needs a user identity to own the session', async () => {
    const res = await request(mount(asGlobalKey))
      .post('/api/projects/web/sessions/dispatch')
      .send({ prompt: 'x' })
      .expect(401);
    expect(res.body.code).toBe('authentication_required');
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('404s unknown projects and the Hub system project', async () => {
    await request(mount(asUser))
      .post('/api/projects/nope/sessions/dispatch')
      .send({ prompt: 'x' })
      .expect(404);
    await request(mount(asUser))
      .post(`/api/projects/${HUB_PROJECT_ID}/sessions/dispatch`)
      .send({ prompt: 'x' })
      .expect(404);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('rejects an empty prompt and unknown modes', async () => {
    await request(mount(asUser))
      .post('/api/projects/web/sessions/dispatch')
      .send({ prompt: '  ' })
      .expect(400);
    await request(mount(asUser))
      .post('/api/projects/web/sessions/dispatch')
      .send({ prompt: 'x', mode: 'design' })
      .expect(400);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('maps dispatch errors to 400 / 503', async () => {
    mocks.dispatch.mockImplementationOnce(() => {
      throw new BackgroundSessionDispatchError('no_session_agent', 'Agent "docs" cannot host');
    });
    const bad = await request(mount(asUser))
      .post('/api/projects/web/sessions/dispatch')
      .send({ prompt: 'x', agentId: 'docs' })
      .expect(400);
    expect(bad.body).toEqual({ error: 'Agent "docs" cannot host', code: 'no_session_agent' });

    mocks.dispatch.mockImplementationOnce(() => {
      throw new BackgroundSessionDispatchError('no_hook', 'not ready');
    });
    await request(mount(asUser))
      .post('/api/projects/web/sessions/dispatch')
      .send({ prompt: 'x' })
      .expect(503);
  });
});

describe('sessionNameFromPrompt', () => {
  it('uses the first line and truncates long ones', () => {
    expect(sessionNameFromPrompt('  Short title\nmore')).toBe('Short title');
    const long = 'a'.repeat(80);
    const name = sessionNameFromPrompt(long);
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name.endsWith('...')).toBe(true);
  });

  describe('idempotencyKey', () => {
    async function mountWithKeys(
      auth: Record<string, unknown>,
      broadcast?: RouteDeps['broadcast'],
    ): Promise<Express> {
      const { getStmts } = await import('../db.js');
      const real = getStmts();
      const app = express();
      app.use(express.json());
      app.use((req: Request, _res: Response, next: NextFunction) => {
        Object.assign(req, auth);
        next();
      });
      app.use(
        createSessionDispatchRoutes({
          findProject: (id: string) => (id === 'web' ? project : null),
          stmts: {
            getSession: { get: (id: string) => sessions[id] },
            claimSessionDispatchKey: real.claimSessionDispatchKey,
            getSessionDispatchKey: real.getSessionDispatchKey,
            completeSessionDispatchKey: real.completeSessionDispatchKey,
            releaseSessionDispatchKey: real.releaseSessionDispatchKey,
            pruneSessionDispatchKeys: real.pruneSessionDispatchKeys,
          },
          broadcast,
        } as unknown as RouteDeps),
      );
      return app;
    }

    it("publishes a forward card's start so every device's copy stops counting", async () => {
      const broadcast = vi.fn();
      const deviceA = await mountWithKeys(asOwner, broadcast);
      const body = {
        prompt: 'Press start',
        idempotencyKey: 'session-forward:orch-sess:m-9:card:0',
      };
      await request(deviceA).post('/api/projects/web/sessions/dispatch').send(body).expect(201);
      const started = broadcast.mock.calls
        .map((c) => c[0])
        .filter((e) => e.type === 'session_forward_started');
      expect(started).toEqual([
        {
          type: 'session_forward_started',
          sessionId: 'orch-sess',
          ownerUserId: 'owner-1',
          dispatchKey: 'session-forward:orch-sess:m-9:card:0',
          started: {
            sessionId: 'new-sess',
            agentId: 'web-dev',
            name: 'Press start',
            mode: 'manual',
          },
        },
      ]);

      // A repeat (another device, or the server countdown) reports the same start.
      broadcast.mockClear();
      await request(deviceA).post('/api/projects/web/sessions/dispatch').send(body).expect(200);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'session_forward_started',
          dispatchKey: 'session-forward:orch-sess:m-9:card:0',
          started: expect.objectContaining({ sessionId: 'new-sess' }),
        }),
      );
    });

    it('does not publish a start for keys that are not forward cards', async () => {
      const broadcast = vi.fn();
      const app = await mountWithKeys(asOwner, broadcast);
      await request(app)
        .post('/api/projects/web/sessions/dispatch')
        .send({ prompt: 'Plain', idempotencyKey: 'card:plain-1' })
        .expect(201);
      expect(broadcast.mock.calls.map((c) => c[0].type)).not.toContain('session_forward_started');
    });

    it('starts one session when two clients send the same card at once', async () => {
      const tabA = await mountWithKeys(asOwner);
      const tabB = await mountWithKeys(asOwner);
      const body = { prompt: 'Rename the park', name: 'Rename', idempotencyKey: 'card:k1' };
      const [a, b] = await Promise.all([
        request(tabA).post('/api/projects/web/sessions/dispatch').send(body),
        request(tabB)
          .post('/api/projects/web/sessions/dispatch')
          .send({ ...body, mode: 'push' }),
      ]);
      expect(mocks.dispatch).toHaveBeenCalledTimes(1);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(a.body.sessionId).toBe('new-sess');
      expect(b.body.sessionId).toBe('new-sess');
      expect(b.body.ref).toBe(a.body.ref);
      // The push request lost the race: it must hear the mode the session
      // actually started with, not the one it asked for.
      const winner = a.status === 201 ? a : b;
      expect(a.body.mode).toBe(winner.body.mode);
      expect(b.body.mode).toBe(winner.body.mode);
    });

    it('a launched forward card is recorded and re-announces the chat that posted it', async () => {
      const { getStmts } = await import('../db.js');
      const { sessionForwardDispatchKeyPrefix } =
        await import('../../shared/utils/sessionForwardDispatchKey.js');
      const broadcast = vi.fn();
      const app = await mountWithKeys(asOwner, broadcast);
      await request(app)
        .post('/api/projects/web/sessions/dispatch')
        .send({ prompt: 'Fix the rows', idempotencyKey: 'session-forward:chat-f:msg-f:fwd:0' })
        .expect(201);
      const prefix = sessionForwardDispatchKeyPrefix('chat-f', 'msg-f');
      expect(getStmts().listLaunchedSessionForwardKeys.all(prefix, prefix)).toEqual([
        { idem_key: 'session-forward:chat-f:msg-f:fwd:0' },
      ]);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'session_needs_input', sessionId: 'chat-f' }),
      );
    });

    it('replays the started mode, not the mode the repeat asked for', async () => {
      const app = await mountWithKeys(asOwner);
      const body = { prompt: 'Ship it', idempotencyKey: 'card:k5' };
      const first = await request(app)
        .post('/api/projects/web/sessions/dispatch')
        .send({ ...body, mode: 'manual' })
        .expect(201);
      const repeat = await request(app)
        .post('/api/projects/web/sessions/dispatch')
        .send({ ...body, mode: 'push' })
        .expect(200);
      expect(first.body.mode).toBe('manual');
      expect(repeat.body).toMatchObject({ sessionId: first.body.sessionId, mode: 'manual' });
      expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    });

    it('refuses the same key for a different request', async () => {
      const app = await mountWithKeys(asOwner);
      await request(app)
        .post('/api/projects/web/sessions/dispatch')
        .send({ prompt: 'First', idempotencyKey: 'card:k2' })
        .expect(201);
      const res = await request(app)
        .post('/api/projects/web/sessions/dispatch')
        .send({ prompt: 'Something else', idempotencyKey: 'card:k2' })
        .expect(409);
      expect(res.body.code).toBe('idempotency_key_reused');
      expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    });

    it('frees the key when the dispatch fails so a retry can start it', async () => {
      const app = await mountWithKeys(asOwner);
      mocks.dispatch.mockImplementationOnce(() => {
        throw new BackgroundSessionDispatchError('no_session_agent', 'No agent');
      });
      await request(app)
        .post('/api/projects/web/sessions/dispatch')
        .send({ prompt: 'Retry me', idempotencyKey: 'card:k3' })
        .expect(400);
      await request(app)
        .post('/api/projects/web/sessions/dispatch')
        .send({ prompt: 'Retry me', idempotencyKey: 'card:k3' })
        .expect(201);
      expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    });

    it('keeps keys separate per user', async () => {
      await request(await mountWithKeys(asOwner))
        .post('/api/projects/web/sessions/dispatch')
        .send({ prompt: 'Same', idempotencyKey: 'card:k4' })
        .expect(201);
      await request(await mountWithKeys(asUser))
        .post('/api/projects/web/sessions/dispatch')
        .send({ prompt: 'Same', idempotencyKey: 'card:k4' })
        .expect(201);
      expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    });
  });
});
