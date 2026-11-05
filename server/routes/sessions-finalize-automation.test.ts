import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteDeps, SessionRow } from '../types.js';

const mocks = vi.hoisted(() => ({
  maybeAutoStartFinalizeForSession: vi.fn(async () => undefined),
  maybeAutoPushReadyFinalizeRun: vi.fn(async () => undefined),
}));

vi.mock('../finalize/automation-runner.js', () => ({
  maybeAutoStartFinalizeForSession: mocks.maybeAutoStartFinalizeForSession,
  maybeAutoPushReadyFinalizeRun: mocks.maybeAutoPushReadyFinalizeRun,
}));

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
    changes_ready: JSON.stringify({
      branch: 'feature/x',
      hasUncommitted: true,
      hasUnpushed: false,
    }),
    stale_pr_notified_at: null,
    ask_mode: 0,
    cron_id: null,
    created_at: '2026-06-07 17:00:00',
    updated_at: '2026-06-07 17:00:00',
    deleted_at: null,
    finalize_automation: 'manual',
    state: 'waiting_for_user_input',
    ...overrides,
  };
}

function makeApp(
  options: {
    session?: Partial<SessionRow>;
    activeTaskStatus?: string;
    latestRun?: { id: string; status: string; mode: string };
  } = {},
) {
  const session = makeSession(options.session);
  const stmts = {
    updateSessionFinalizeAutomation: {
      run: vi.fn((level: string) => {
        session.finalize_automation = level;
      }),
    },
    updateSessionName: { run: vi.fn() },
    getSession: { get: vi.fn(() => session) },
    getSessionAgents: { all: vi.fn(() => []) },
    getKanbanCardBySession: { get: vi.fn(() => undefined) },
    getLatestFinalizeRunForSession: { get: vi.fn(() => options.latestRun) },
    getActiveTask: {
      get: vi.fn(() =>
        options.activeTaskStatus ? { status: options.activeTaskStatus } : undefined,
      ),
    },
    getKanbanColumn: { get: vi.fn(() => undefined) },
    updateSessionState: { run: vi.fn() },
  };
  const deps = {
    stmts,
    config: { publicUrl: null },
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
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use(createSessionRoutes(deps));
  return { app, session, stmts, broadcast: deps.broadcast as ReturnType<typeof vi.fn> };
}

describe('PATCH /api/sessions/:sessionId finalize_automation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.maybeAutoStartFinalizeForSession.mockResolvedValue(undefined);
  });

  // Regression: changing the Build / Build&Push / Automerge dropdown must
  // persist the chosen level but NEVER start a Finalize run on its own. The
  // level is honored at the next end-of-turn auto-commit (auto-git.ts →
  // maybeAutoStartFinalizeForSession), not the moment the operator picks it.
  it.each(['review', 'push', 'merge'] as const)(
    'persists %s without starting Finalize on a session waiting for user input',
    async (level) => {
      const { app, stmts } = makeApp();

      const res = await request(app)
        .patch('/api/sessions/sess-1')
        .send({ finalize_automation: level })
        .expect(200);

      expect(res.body.finalize_automation).toBe(level);
      expect(stmts.updateSessionFinalizeAutomation.run).toHaveBeenCalledWith(level, 'sess-1');
      expect(mocks.maybeAutoStartFinalizeForSession).not.toHaveBeenCalled();
    },
  );

  it('does not start Finalize when selecting Auto Merge during an active turn', async () => {
    const { app } = makeApp({
      session: { state: 'working' },
      activeTaskStatus: 'running',
    });

    const res = await request(app)
      .patch('/api/sessions/sess-1')
      .send({ finalize_automation: 'merge' })
      .expect(200);

    expect(res.body.finalize_automation).toBe('merge');
    expect(mocks.maybeAutoStartFinalizeForSession).not.toHaveBeenCalled();
  });

  it('does not start Finalize when selecting manual Build mode', async () => {
    const { app } = makeApp();

    const res = await request(app)
      .patch('/api/sessions/sess-1')
      .send({ finalize_automation: 'manual' })
      .expect(200);

    expect(res.body.finalize_automation).toBe('manual');
    expect(mocks.maybeAutoStartFinalizeForSession).not.toHaveBeenCalled();
  });

  // Regression: a run parked at ready_to_push under Build/Review stayed parked
  // after the operator switched to Auto Merge, because auto-push only fired at
  // the moment the run first parked.
  it.each(['push', 'merge'] as const)(
    'pushes a full run already parked at ready_to_push when switching to %s',
    async (level) => {
      const { app } = makeApp({
        session: { finalize_automation: 'review' },
        latestRun: { id: 'run-1', status: 'ready_to_push', mode: 'full' },
      });

      await request(app)
        .patch('/api/sessions/sess-1')
        .send({ finalize_automation: level })
        .expect(200);

      expect(mocks.maybeAutoPushReadyFinalizeRun).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        runId: 'run-1',
      });
      expect(mocks.maybeAutoStartFinalizeForSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['review', { id: 'run-1', status: 'ready_to_push', mode: 'full' }],
    ['manual', { id: 'run-1', status: 'ready_to_push', mode: 'full' }],
    ['merge', { id: 'run-1', status: 'running', mode: 'full' }],
    ['merge', { id: 'run-1', status: 'pushed', mode: 'full' }],
    ['merge', { id: 'run-1', status: 'ready_to_push', mode: 'checks' }],
    ['merge', { id: 'run-1', status: 'ready_to_push', mode: 'review' }],
  ] as const)('does not push when switching to %s with latest run %o', async (level, run) => {
    const { app } = makeApp({ latestRun: { ...run } });

    await request(app)
      .patch('/api/sessions/sess-1')
      .send({ finalize_automation: level })
      .expect(200);

    expect(mocks.maybeAutoPushReadyFinalizeRun).not.toHaveBeenCalled();
  });

  it('does not push when the PATCH leaves the automation level unchanged', async () => {
    const { app } = makeApp({
      session: { finalize_automation: 'merge' },
      latestRun: { id: 'run-1', status: 'ready_to_push', mode: 'full' },
    });

    await request(app).patch('/api/sessions/sess-1').send({ name: 'Renamed' }).expect(200);

    expect(mocks.maybeAutoPushReadyFinalizeRun).not.toHaveBeenCalled();
  });
});
