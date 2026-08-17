import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteDeps, SessionRow } from '../types.js';

const mocks = vi.hoisted(() => ({
  isFirecrackerBackendRegistered: vi.fn(() => false),
  resolveSessionEnvAdapterForSession: vi.fn(
    ({ session }: { session?: { session_mode?: string | null } | null }) =>
      session?.session_mode === 'isolated' ? 'firecracker' : 'host',
  ),
}));

vi.mock('../session-env/resolve-session-adapter.js', () => ({
  isFirecrackerBackendRegistered: mocks.isFirecrackerBackendRegistered,
  resolveSessionEnvAdapterForSession: mocks.resolveSessionEnvAdapterForSession,
}));

vi.mock('../db.js', () => {
  const fakeDb = {
    transaction: (fn: () => void) => {
      const run = () => fn();
      return run;
    },
    prepare: () => ({ run: () => undefined, get: () => undefined, all: () => [] }),
  };
  return {
    getDb: () => fakeDb,
    db: fakeDb,
    stmts: {},
    initDb: () => undefined,
    getStmts: () => ({}),
  };
});

const { default: createSessionRoutes } = await import('./sessions.js');

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    agent_id: 'agent-1',
    name: 'Idle session',
    engine: 'codex-cli',
    model: 'gpt-5.5',
    engine_session_id: null,
    use_worktree: 1,
    worktree_path: '/tmp/worktree',
    worktree_branch: 'feature/x',
    git_worktree_detected: 1,
    changes_ready: null,
    stale_pr_notified_at: null,
    ask_mode: 0,
    cron_id: null,
    created_at: '2026-06-07 17:00:00',
    updated_at: '2026-06-07 17:00:00',
    deleted_at: null,
    finalize_automation: 'manual',
    session_mode: 'chat',
    state: 'waiting_for_user_input',
    ...overrides,
  };
}

function makeApp(
  options: { session?: Partial<SessionRow>; dispose?: ReturnType<typeof vi.fn> } = {},
) {
  const session = makeSession(options.session);
  const stmts = {
    updateSessionMode: {
      run: vi.fn((mode: string) => {
        session.session_mode = mode;
      }),
    },
    updateSessionAskMode: {
      run: vi.fn((ask: number) => {
        session.ask_mode = ask;
      }),
    },
    updateSessionFinalizeAutomation: {
      run: vi.fn((level: string) => {
        session.finalize_automation = level;
      }),
    },
    updateSessionName: { run: vi.fn() },
    updateSessionMaxTurns: { run: vi.fn() },
    getSession: { get: vi.fn(() => session) },
    getSessionAgents: { all: vi.fn(() => []) },
    getKanbanCardBySession: { get: vi.fn(() => undefined) },
    getLatestFinalizeRunForSession: { get: vi.fn(() => undefined) },
    getActiveTask: { get: vi.fn(() => undefined) },
    getKanbanColumn: { get: vi.fn(() => undefined) },
    updateSessionState: { run: vi.fn() },
  };
  const disposeSessionEnv =
    options.dispose ??
    vi.fn(async () => {
      /* no-op */
    });
  let transitionTail = Promise.resolve();
  const transitionSessionEnv = vi.fn(
    (
      sessionId: string,
      applyTransition: (disposeCurrent: () => Promise<void>) => void | Promise<void>,
    ) => {
      const transition = transitionTail
        .catch(() => undefined)
        .then(() =>
          applyTransition(() => (disposeSessionEnv as (id: string) => Promise<void>)(sessionId)),
        );
      transitionTail = transition.then(
        () => undefined,
        () => undefined,
      );
      return transition;
    },
  );
  const deps = {
    stmts,
    config: { publicUrl: null, dataDir: '/tmp' },
    getEnrichedAgent: vi.fn(() => ({
      id: 'agent-1',
      name: 'Agent Hub Dev',
      color: '#333333',
      role: 'dev',
      projectId: 'agent-hub',
      projectName: 'agent-hub',
    })),
    findAgent: vi.fn(() => ({
      project: {
        id: 'agent-hub',
        name: 'agent-hub',
        cwd: '/tmp/agent-hub',
        ahw: '/tmp/agent-hub/.ahw',
        mode: 'dev',
        agents: [],
      },
      agent: {
        id: 'agent-1',
        name: 'Agent Hub Dev',
        color: '#333333',
        role: 'dev',
      },
    })),
    broadcast: vi.fn(),
    disposeSessionEnv,
    transitionSessionEnv,
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use(createSessionRoutes(deps));
  return { app, session, stmts, disposeSessionEnv, transitionSessionEnv };
}

describe('isolated (VM) session mode routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isFirecrackerBackendRegistered.mockReturnValue(false);
    mocks.resolveSessionEnvAdapterForSession.mockImplementation(
      ({ session }: { session?: { session_mode?: string | null } | null }) =>
        session?.session_mode === 'isolated' ? 'firecracker' : 'host',
    );
  });

  it('PUT /mode returns 400 when Firecracker is not registered', async () => {
    const { app, session } = makeApp();
    const res = await request(app)
      .put('/api/sessions/sess-1/mode')
      .send({ mode: 'isolated' })
      .expect(400);
    expect(res.body.error).toBe('isolated_mode_requires_firecracker');
    expect(session.session_mode).toBe('chat');
  });

  it('PATCH returns 400 when Firecracker is not registered', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .patch('/api/sessions/sess-1')
      .send({ session_mode: 'isolated' })
      .expect(400);
    expect(res.body.error).toBe('isolated_mode_requires_firecracker');
  });

  it('PUT /mode enters isolated, disposes warm host env, and keeps ship automation', async () => {
    mocks.isFirecrackerBackendRegistered.mockReturnValue(true);
    const { app, session, disposeSessionEnv, transitionSessionEnv, stmts } = makeApp({
      session: { finalize_automation: 'push' },
    });

    const res = await request(app)
      .put('/api/sessions/sess-1/mode')
      .send({ mode: 'isolated' })
      .expect(200);

    expect(res.body.session_mode).toBe('isolated');
    expect(session.finalize_automation).toBe('push');
    expect(stmts.updateSessionFinalizeAutomation.run).not.toHaveBeenCalled();
    expect(disposeSessionEnv).toHaveBeenCalledWith('sess-1');
    expect(transitionSessionEnv).toHaveBeenCalledTimes(1);
  });

  it('PATCH enters isolated and disposes when adapter would flip', async () => {
    mocks.isFirecrackerBackendRegistered.mockReturnValue(true);
    const { app, disposeSessionEnv, transitionSessionEnv } = makeApp();

    const res = await request(app)
      .patch('/api/sessions/sess-1')
      .send({ session_mode: 'isolated' })
      .expect(200);

    expect(res.body.session_mode).toBe('isolated');
    expect(disposeSessionEnv).toHaveBeenCalledWith('sess-1');
    expect(transitionSessionEnv).toHaveBeenCalledTimes(1);
  });

  it('does not dispose when adapter stays the same (chat → design under host)', async () => {
    mocks.resolveSessionEnvAdapterForSession.mockReturnValue('host');
    const { app, disposeSessionEnv, transitionSessionEnv } = makeApp();

    await request(app).put('/api/sessions/sess-1/mode').send({ mode: 'design' }).expect(200);

    expect(disposeSessionEnv).not.toHaveBeenCalled();
    expect(transitionSessionEnv).toHaveBeenCalledOnce();
  });

  it.each(['PUT /mode', 'PATCH'] as const)(
    'serializes a later chat selection behind an in-flight isolated selection through %s',
    async (route) => {
      mocks.isFirecrackerBackendRegistered.mockReturnValue(true);
      let releaseDispose!: () => void;
      const disposeBlocked = new Promise<void>((resolve) => {
        releaseDispose = resolve;
      });
      let signalDisposeStarted!: () => void;
      const disposeStarted = new Promise<void>((resolve) => {
        signalDisposeStarted = resolve;
      });
      const dispose = vi.fn(async () => {
        signalDisposeStarted();
        await disposeBlocked;
      });
      const { app, session, transitionSessionEnv } = makeApp({ dispose });
      const sendMode = (mode: 'chat' | 'isolated') =>
        route === 'PUT /mode'
          ? request(app).put('/api/sessions/sess-1/mode').send({ mode })
          : request(app).patch('/api/sessions/sess-1').send({ session_mode: mode });

      const isolatedResponse = sendMode('isolated').then((response) => response);
      await disposeStarted;

      let chatFinished = false;
      const chatResponse = sendMode('chat').then((response) => {
        chatFinished = true;
        return response;
      });
      await vi.waitFor(() => expect(transitionSessionEnv).toHaveBeenCalledTimes(2));

      expect(chatFinished).toBe(false);
      expect(session.session_mode).toBe('chat');

      releaseDispose();
      const [isolated, chat] = await Promise.all([isolatedResponse, chatResponse]);
      expect(isolated.status).toBe(200);
      expect(chat.status).toBe(200);
      expect(chat.body.session_mode).toBe('chat');
      expect(session.session_mode).toBe('chat');
      expect(dispose).toHaveBeenCalledTimes(2);
    },
  );
});
