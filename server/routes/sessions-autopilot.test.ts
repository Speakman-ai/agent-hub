import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteDeps, SessionRow } from '../types.js';

const mocks = vi.hoisted(() => ({
  kickoffSeededTurn: vi.fn(async (_args: { content?: string }) => undefined),
  checkWorktreeChanges: vi.fn(async () => ({ hasUncommitted: false, hasUnpushed: false })),
}));

vi.mock('../seeded-session-kickoff.js', () => ({
  kickoffSeededTurn: mocks.kickoffSeededTurn,
}));

vi.mock('../auto-git.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, checkWorktreeChanges: mocks.checkWorktreeChanges };
});

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

const VALID_BODY = {
  durationHours: 4,
  brief: 'Harden the 3D print UI',
  goal: 'Baseline journeys pass on preview',
  escalation: 'medium',
  branch: 'autopilot/print-ui',
};

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    agent_id: 'agent-1',
    name: 'Idle session',
    engine: 'codex-cli',
    model: 'gpt-5.5',
    engine_session_id: null,
    use_worktree: 1,
    worktree_path: null,
    worktree_branch: null,
    git_worktree_detected: 0,
    changes_ready: null,
    stale_pr_notified_at: null,
    ask_mode: 0,
    cron_id: null,
    created_at: '2026-06-07 17:00:00',
    updated_at: '2026-06-07 17:00:00',
    deleted_at: null,
    finalize_automation: 'manual',
    session_mode: 'chat',
    autopilot_session_config: null,
    state: 'waiting_for_user_input',
    ...overrides,
  };
}

function makeApp(options: { session?: Partial<SessionRow>; projectMode?: string } = {}) {
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
    updateSessionReactLoop: { run: vi.fn() },
    updateSessionAutopilotConfig: {
      run: vi.fn((json: string) => {
        session.autopilot_session_config = json;
      }),
    },
    updateSessionWorktreeBranch: {
      run: vi.fn((branch: string) => {
        session.worktree_branch = branch;
      }),
    },
    setSessionWorktreeCheckoutBranch: {
      run: vi.fn((branch: string) => {
        session.worktree_checkout_branch = branch;
      }),
    },
    updateSessionName: { run: vi.fn() },
    updateSessionMaxTurns: { run: vi.fn() },
    getSession: { get: vi.fn(() => session) },
    getSessionAgents: { all: vi.fn(() => []) },
    getKanbanCardBySession: { get: vi.fn(() => undefined) },
    getLatestFinalizeRunForSession: { get: vi.fn(() => undefined) },
    getActiveTask: { get: vi.fn(() => undefined) },
    getActiveFinalizeRuns: { all: vi.fn(() => []) },
    getKanbanColumn: { get: vi.fn(() => undefined) },
    updateSessionState: { run: vi.fn() },
  };
  const transitionSessionEnv = vi.fn(
    async (
      _sessionId: string,
      applyTransition: (disposeCurrent: () => Promise<void>) => void | Promise<void>,
    ) => {
      await applyTransition(async () => undefined);
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
        mode: options.projectMode ?? 'dev',
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
    handleChat: vi.fn(),
    transitionSessionEnv,
    activeProcesses: new Map(),
    drainSessionQueue: vi.fn(),
    getSessionWorktreeIo: vi.fn(async () => ({}) as never),
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use(createSessionRoutes(deps));
  return { app, session, stmts, deps };
}

describe('session Autopilot routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.kickoffSeededTurn.mockResolvedValue(undefined);
  });

  it('PUT /mode pins Finalize to push when entering Autopilot', async () => {
    const { app, session, stmts } = makeApp({ session: { finalize_automation: 'manual' } });
    const res = await request(app)
      .put('/api/sessions/sess-1/mode')
      .send({ mode: 'autopilot' })
      .expect(200);
    expect(res.body.session_mode).toBe('autopilot');
    expect(session.finalize_automation).toBe('push');
    expect(stmts.updateSessionFinalizeAutomation.run).toHaveBeenCalledWith('push', 'sess-1');
  });

  it('PATCH refuses merge while Autopilot is active', async () => {
    const { app } = makeApp({
      session: { session_mode: 'autopilot', finalize_automation: 'push' },
    });
    const res = await request(app)
      .patch('/api/sessions/sess-1')
      .send({ finalize_automation: 'merge' })
      .expect(400);
    expect(res.body.error).toBe('autopilot_does_not_merge');
  });

  it('POST /autopilot persists config, binds the branch, and kicks the first turn', async () => {
    const { app, session, stmts } = makeApp();
    const res = await request(app)
      .post('/api/sessions/sess-1/autopilot')
      .send(VALID_BODY)
      .expect(200);

    expect(session.session_mode).toBe('autopilot');
    expect(session.finalize_automation).toBe('push');
    expect(session.worktree_branch).toBe('autopilot/print-ui');
    expect(stmts.updateSessionReactLoop.run).toHaveBeenCalledWith(1, 'sess-1');
    expect(res.body.autopilot).toMatchObject({
      brief: VALID_BODY.brief,
      goal: VALID_BODY.goal,
      branch: VALID_BODY.branch,
      status: 'running',
    });
    expect(mocks.kickoffSeededTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        agentId: 'agent-1',
      }),
    );
    const kickoff = mocks.kickoffSeededTurn.mock.calls[0]?.[0] as { content?: string } | undefined;
    expect(kickoff?.content).toContain('autopilot/print-ui');
    expect(kickoff?.content).toContain(VALID_BODY.goal);
  });

  it('POST /autopilot rejects reserved branches', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/sessions/sess-1/autopilot')
      .send({ ...VALID_BODY, branch: 'main' })
      .expect(400);
    expect(res.body.error).toBe('invalid_autopilot_setup');
    expect(mocks.kickoffSeededTurn).not.toHaveBeenCalled();
  });

  it('POST /autopilot is rejected on a workflow project', async () => {
    const { app } = makeApp({ projectMode: 'workflow' });
    const res = await request(app)
      .post('/api/sessions/sess-1/autopilot')
      .send(VALID_BODY)
      .expect(400);
    expect(res.body.error).toBe('autopilot_not_allowed_on_workflow_project');
  });

  it('POST /autopilot records the branch as the existing-branch checkout target (unprovisioned)', async () => {
    const { app, session, stmts } = makeApp();
    await request(app).post('/api/sessions/sess-1/autopilot').send(VALID_BODY).expect(200);
    // Provisioning later positions on the existing remote branch tip via
    // worktree_checkout_branch (blocker 5), while worktree_branch names the
    // fresh branch when the ref does not exist yet.
    expect(stmts.setSessionWorktreeCheckoutBranch.run).toHaveBeenCalledWith(
      'autopilot/print-ui',
      'sess-1',
    );
    expect(session.worktree_checkout_branch).toBe('autopilot/print-ui');
    expect(session.worktree_branch).toBe('autopilot/print-ui');
  });

  it('POST /autopilot is rejected when the worktree lock is already held', async () => {
    const { app } = makeApp();
    const { tryAcquireSessionWorktreeLock, releaseSessionWorktreeLock } =
      await import('../session-worktree-lock.js');
    expect(tryAcquireSessionWorktreeLock('sess-1', 'turn-start')).toBe(true);
    try {
      const res = await request(app)
        .post('/api/sessions/sess-1/autopilot')
        .send(VALID_BODY)
        .expect(409);
      expect(res.body.error).toBe('autopilot_session_busy');
      expect(mocks.kickoffSeededTurn).not.toHaveBeenCalled();
    } finally {
      releaseSessionWorktreeLock('sess-1', 'turn-start');
    }
  });

  it('POST /autopilot refuses while a provisioned session is actively running', async () => {
    const { app, stmts } = makeApp({
      session: { worktree_path: '/tmp/wt/sess-1', worktree_branch: 'agent-hub/x' },
    });
    stmts.getActiveTask.get.mockReturnValue({ status: 'running' } as never);
    const res = await request(app)
      .post('/api/sessions/sess-1/autopilot')
      .send(VALID_BODY)
      .expect(409);
    expect(res.body.error).toBe('autopilot_session_active');
    expect(mocks.kickoffSeededTurn).not.toHaveBeenCalled();
  });

  it('POST /autopilot refuses when a provisioned worktree has unpushed commits', async () => {
    const { app } = makeApp({
      session: { worktree_path: '/tmp/wt/sess-1', worktree_branch: 'agent-hub/x' },
    });
    mocks.checkWorktreeChanges.mockResolvedValueOnce({ hasUncommitted: false, hasUnpushed: true });
    const res = await request(app)
      .post('/api/sessions/sess-1/autopilot')
      .send(VALID_BODY)
      .expect(409);
    expect(res.body.error).toBe('autopilot_worktree_dirty');
    expect(mocks.kickoffSeededTurn).not.toHaveBeenCalled();
  });
});
