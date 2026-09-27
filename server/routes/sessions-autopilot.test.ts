import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteDeps, SessionRow } from '../types.js';

const mocks = vi.hoisted(() => ({
  kickoffSeededTurn: vi.fn(async (_args: { content?: string }) => undefined),
  checkWorktreeChanges: vi.fn(async () => ({ hasUncommitted: false, hasUnpushed: false })),
  unstickAutopilotSession: vi.fn(),
  checkMainlineAutopilotTarget: vi.fn(),
  mainlineCandidates: [] as Array<Record<string, unknown>>,
}));

vi.mock('../seeded-session-kickoff.js', () => ({
  kickoffSeededTurn: mocks.kickoffSeededTurn,
}));

vi.mock('../auto-git.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, checkWorktreeChanges: mocks.checkWorktreeChanges };
});
vi.mock('../session-autopilot-mainline-start.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    checkMainlineAutopilotTarget: mocks.checkMainlineAutopilotTarget,
    listMainlineAutopilotCandidates: () => mocks.mainlineCandidates,
  };
});
vi.mock('../session-autopilot-unstick.js', () => ({
  unstickAutopilotSession: mocks.unstickAutopilotSession,
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
    casSessionAutopilotConfig: {
      run: vi.fn((json: string, _id: string, expected: string | null) => {
        if ((session.autopilot_session_config ?? null) !== expected) return { changes: 0 };
        session.autopilot_session_config = json;
        return { changes: 1 };
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
    mocks.mainlineCandidates = [];
    mocks.checkMainlineAutopilotTarget.mockResolvedValue({
      ok: true,
      defaultBranch: 'main',
      declaredEnvironments: ['staging', 'production'],
    });
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

  it('passes uploaded brief attachments to the opening turn', async () => {
    const { app } = makeApp();
    const images = [
      {
        id: 'upload-1',
        filename: 'upload-1.png',
        originalName: 'reference.png',
        contentType: 'image/png',
        url: '/uploads/upload-1.png',
      },
    ];
    await request(app)
      .post('/api/sessions/sess-1/autopilot')
      .send({ ...VALID_BODY, images })
      .expect(200);
    expect(mocks.kickoffSeededTurn).toHaveBeenCalledWith(expect.objectContaining({ images }));
  });

  it('rejects attachment paths before changing the session', async () => {
    const { app, stmts } = makeApp();
    await request(app)
      .post('/api/sessions/sess-1/autopilot')
      .send({
        ...VALID_BODY,
        images: [
          {
            id: 'bad',
            filename: '../secret',
            originalName: 'secret',
            contentType: 'text/plain',
            url: '/uploads/secret',
          },
        ],
      })
      .expect(400);
    expect(stmts.updateSessionMode.run).not.toHaveBeenCalled();
    expect(mocks.kickoffSeededTurn).not.toHaveBeenCalled();
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

  describe('mainline target', () => {
    const MAINLINE_BODY = {
      durationHours: 4,
      brief: 'Harden the 3D print UI',
      goal: 'Baseline journeys pass on staging',
      escalation: 'medium',
      target: 'mainline',
      deployEnvironment: 'staging',
    };

    beforeEach(() => {
      vi.stubEnv('AGENT_HUB_AUTOPILOT_MAINLINE', '1');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('is refused until the landing path is available', async () => {
      vi.stubEnv('AGENT_HUB_AUTOPILOT_MAINLINE', '');
      const { app, stmts } = makeApp();
      const res = await request(app)
        .post('/api/sessions/sess-1/autopilot')
        .send(MAINLINE_BODY)
        .expect(400);
      expect(res.body.error).toBe('autopilot_mainline_unavailable');
      expect(mocks.checkMainlineAutopilotTarget).not.toHaveBeenCalled();
      expect(stmts.updateSessionMode.run).not.toHaveBeenCalled();
      expect(mocks.kickoffSeededTurn).not.toHaveBeenCalled();
    });

    function mainlineConfig(phase: string, overrides: Record<string, unknown> = {}) {
      return JSON.stringify({
        durationHours: 4,
        brief: 'b',
        goal: 'g',
        escalation: 'none',
        branch: 'main',
        startedAt: '2026-09-27T10:00:00.000Z',
        deadlineAt: null,
        status: 'running',
        cycle: 0,
        lastPushSha: null,
        target: 'mainline',
        mainline: {
          deployEnvironment: 'staging',
          landedCount: 2,
          slot:
            phase === 'idle'
              ? { phase: 'idle' }
              : { phase, attemptId: 'att-1', sha: 'abcdef1234567', deploymentId: 'dep-1' },
        },
        ...overrides,
      });
    }

    it('persists a mainline config on the default branch without binding a branch', async () => {
      const { app, session, stmts } = makeApp();
      const res = await request(app)
        .post('/api/sessions/sess-1/autopilot')
        .send(MAINLINE_BODY)
        .expect(200);
      expect(stmts.updateSessionWorktreeBranch.run).not.toHaveBeenCalled();
      expect(stmts.setSessionWorktreeCheckoutBranch.run).not.toHaveBeenCalled();
      expect(session.worktree_branch).toBeNull();
      expect(res.body.autopilot).toMatchObject({
        target: 'mainline',
        branch: 'main',
        status: 'running',
        mainline: { deployEnvironment: 'staging', landedCount: 0, slot: { phase: 'idle' } },
      });
      const kickoff = mocks.kickoffSeededTurn.mock.calls[0]?.[0] as { content?: string };
      expect(kickoff.content).toContain('deploys environment `staging`');
      expect(kickoff.content).toContain('live environment');
    });

    it('requires a deploy environment', async () => {
      const { app } = makeApp();
      const res = await request(app)
        .post('/api/sessions/sess-1/autopilot')
        .send({ ...MAINLINE_BODY, deployEnvironment: '' })
        .expect(400);
      expect(res.body.error).toBe('invalid_autopilot_setup');
      expect(res.body.details).toEqual([expect.objectContaining({ field: 'deployEnvironment' })]);
    });

    it('returns the preflight error with the declared environments', async () => {
      mocks.checkMainlineAutopilotTarget.mockResolvedValue({
        ok: false,
        error: 'autopilot_deploy_env_unknown',
        message: 'deploy.yaml on \'main\' does not declare environment "staging".',
        declaredEnvironments: ['production'],
      });
      const { app, stmts } = makeApp();
      const res = await request(app)
        .post('/api/sessions/sess-1/autopilot')
        .send(MAINLINE_BODY)
        .expect(400);
      expect(res.body).toMatchObject({
        error: 'autopilot_deploy_env_unknown',
        declaredEnvironments: ['production'],
      });
      expect(stmts.updateSessionMode.run).not.toHaveBeenCalled();
      expect(mocks.kickoffSeededTurn).not.toHaveBeenCalled();
    });

    it('refuses when another session runs mainline Autopilot on the environment', async () => {
      mocks.mainlineCandidates = [
        {
          id: 'sess-2',
          agent_id: 'agent-1',
          session_mode: 'autopilot',
          deleted_at: null,
          autopilot_session_config: mainlineConfig('idle'),
        },
      ];
      const { app, stmts } = makeApp();
      const res = await request(app)
        .post('/api/sessions/sess-1/autopilot')
        .send(MAINLINE_BODY)
        .expect(409);
      expect(res.body).toMatchObject({
        error: 'autopilot_environment_owned',
        ownerSessionId: 'sess-2',
      });
      expect(stmts.updateSessionMode.run).not.toHaveBeenCalled();
    });

    it('re-checks ownership at write time, after the preflight awaits', async () => {
      mocks.checkMainlineAutopilotTarget.mockImplementation(async () => {
        // Another session claims the environment while the preflight reads git.
        mocks.mainlineCandidates = [
          {
            id: 'sess-2',
            agent_id: 'agent-1',
            session_mode: 'autopilot',
            deleted_at: null,
            autopilot_session_config: mainlineConfig('idle'),
          },
        ];
        return { ok: true, defaultBranch: 'main', declaredEnvironments: ['staging'] };
      });
      const { app, session } = makeApp();
      const res = await request(app)
        .post('/api/sessions/sess-1/autopilot')
        .send(MAINLINE_BODY)
        .expect(409);
      expect(res.body.error).toBe('autopilot_environment_owned');
      expect(session.autopilot_session_config).toBeNull();
      expect(mocks.kickoffSeededTurn).not.toHaveBeenCalled();
    });

    it('allows a different environment or a stopped owner with an idle slot', async () => {
      mocks.mainlineCandidates = [
        {
          id: 'sess-2',
          agent_id: 'agent-1',
          session_mode: 'autopilot',
          deleted_at: null,
          autopilot_session_config: mainlineConfig('idle', { status: 'expired' }),
        },
        {
          id: 'sess-3',
          agent_id: 'agent-1',
          session_mode: 'autopilot',
          deleted_at: null,
          autopilot_session_config: mainlineConfig('idle', {
            mainline: { deployEnvironment: 'production', landedCount: 0, slot: { phase: 'idle' } },
          }),
        },
      ];
      const { app } = makeApp();
      await request(app).post('/api/sessions/sess-1/autopilot').send(MAINLINE_BODY).expect(200);
    });

    it('refuses while a stopped or archived owner still owes a deploy', async () => {
      mocks.mainlineCandidates = [
        {
          id: 'sess-2',
          agent_id: 'agent-1',
          session_mode: 'chat',
          deleted_at: '2026-09-27 11:00:00',
          autopilot_session_config: mainlineConfig('deploying', { status: 'expired' }),
        },
      ];
      const { app } = makeApp();
      const res = await request(app)
        .post('/api/sessions/sess-1/autopilot')
        .send(MAINLINE_BODY)
        .expect(409);
      expect(res.body.error).toBe('autopilot_environment_owned');
      expect(res.body.message).toContain('still landing');
    });

    it.each(['branch', 'mainline'])(
      "refuses a %s start while this session's slot is not idle",
      async (target) => {
        const stored = mainlineConfig('landed', { status: 'expired' });
        const { app, session } = makeApp({
          session: { session_mode: 'autopilot', autopilot_session_config: stored },
        });
        const body = target === 'mainline' ? MAINLINE_BODY : VALID_BODY;
        const res = await request(app)
          .post('/api/sessions/sess-1/autopilot')
          .send(body)
          .expect(409);
        expect(res.body.error).toBe('autopilot_slot_busy');
        expect(session.autopilot_session_config).toBe(stored);
        expect(mocks.kickoffSeededTurn).not.toHaveBeenCalled();
      },
    );

    it('restarts a session whose previous mainline slot is idle', async () => {
      const { app, session } = makeApp({
        session: {
          session_mode: 'autopilot',
          autopilot_session_config: mainlineConfig('idle', { status: 'completed' }),
        },
      });
      await request(app).post('/api/sessions/sess-1/autopilot').send(MAINLINE_BODY).expect(200);
      expect(JSON.parse(session.autopilot_session_config as string)).toMatchObject({
        status: 'running',
        mainline: { landedCount: 0 },
      });
    });
  });

  it('POST /autopilot/unstick kills the hung turn and continues', async () => {
    mocks.unstickAutopilotSession.mockResolvedValue({
      ok: true,
      killedProcess: true,
      cancelledFinalizeRunId: 'run-1',
    });
    const { app } = makeApp({
      session: {
        session_mode: 'autopilot',
        finalize_automation: 'push',
      },
    });
    const res = await request(app)
      .post('/api/sessions/sess-1/autopilot/unstick')
      .send({})
      .expect(200);
    expect(mocks.unstickAutopilotSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1' }),
    );
    expect(res.body.killedProcess).toBe(true);
    expect(res.body.cancelledFinalizeRunId).toBe('run-1');
    expect(res.body.session_mode).toBe('autopilot');
  });

  it('POST /autopilot/unstick forwards helper errors', async () => {
    mocks.unstickAutopilotSession.mockResolvedValue({
      ok: false,
      status: 409,
      error: 'autopilot_not_running',
      message: 'Autopilot is not running on this session.',
    });
    const { app } = makeApp({ session: { session_mode: 'autopilot' } });
    const res = await request(app)
      .post('/api/sessions/sess-1/autopilot/unstick')
      .send({})
      .expect(409);
    expect(res.body.error).toBe('autopilot_not_running');
  });
});
