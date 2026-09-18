import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexModelsCache } from '../codex-model-capability.js';
import type { ChatMessage, RouteDeps, SessionRow } from '../types.js';

// Stub only the per-user cache read; keep the real `resolveSelectableCodexModels`
// so the overlay logic under test actually runs. This mirrors what
// GET /api/config/models does at request time. The mock fn is created via
// `vi.hoisted` so it is initialized before the hoisted `vi.mock` factory can
// reference it (a plain outer `const` would risk a TDZ/hoisting error).
const { readCodexModelsCacheForUser } = vi.hoisted(() => ({
  readCodexModelsCacheForUser: vi.fn<() => CodexModelsCache | null>(() => null),
}));
vi.mock('../codex-model-capability.js', async () => {
  const actual = await vi.importActual<typeof import('../codex-model-capability.js')>(
    '../codex-model-capability.js',
  );
  return { ...actual, readCodexModelsCacheForUser };
});

const { default: createSessionRoutes } = await import('./sessions.js');

function cacheAdvertising(slugs: string[]): CodexModelsCache {
  return { clientVersion: '0.144.0', modelSlugs: new Set(slugs), path: '/tmp/models_cache.json' };
}

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    agent_id: 'agent-1',
    name: 'Codex session',
    engine: 'codex-cli',
    model: 'gpt-5.5',
    owner_user_id: 'user-owner',
    engine_session_id: null,
    use_worktree: 1,
    worktree_path: '/tmp/worktree',
    worktree_branch: 'feature/x',
    git_worktree_detected: 1,
    changes_ready: null,
    stale_pr_notified_at: null,
    ask_mode: 0,
    reasoning_effort: null,
    cron_id: null,
    created_at: '2026-07-13 17:00:00',
    updated_at: '2026-07-13 17:00:00',
    deleted_at: null,
    finalize_automation: 'manual',
    state: 'waiting_for_user_input',
    ...overrides,
  } as SessionRow;
}

function makeApp(options: { session?: Partial<SessionRow> } = {}) {
  const session = makeSession(options.session);
  const stmts = {
    updateSessionModel: {
      run: vi.fn((model: string) => {
        session.model = model;
      }),
    },
    getSession: { get: vi.fn(() => session) },
    getActiveTask: { get: vi.fn(() => undefined as unknown) },
    getSessionAgents: { all: vi.fn(() => []) },
    getKanbanCardBySession: { get: vi.fn(() => undefined) },
  };
  const deps = {
    stmts,
    config: {
      publicUrl: null,
      dataDir: '/tmp/data',
      // Static baseline: no gpt-5.6-* here on purpose (the whole point of the bug).
      engineValidModels: {
        'codex-cli': ['gpt-5.5', 'gpt-5-codex'],
        'claude-code': ['sonnet', 'opus'],
      },
    },
    getEnrichedAgent: vi.fn(() => ({
      id: 'agent-1',
      name: 'Agent Hub Dev',
      color: '#333333',
      role: 'dev',
      projectId: 'agent-hub',
      projectName: 'agent-hub',
    })),
    broadcast: vi.fn(),
    activeProcesses: new Map(),
    handleChat: vi.fn().mockResolvedValue(undefined),
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use(createSessionRoutes(deps));
  return { app, session, stmts, deps };
}

describe('PUT /api/sessions/:sessionId/model — codex capability overlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readCodexModelsCacheForUser.mockReturnValue(null);
  });

  it('persists a capability-gated model the installed codex CLI advertises', async () => {
    // gpt-5.6-sol is NOT in the static baseline but IS advertised by the cache —
    // exactly the picker-vs-save mismatch that made 5.6 "revert" to 5.5.
    readCodexModelsCacheForUser.mockReturnValue(cacheAdvertising(['gpt-5.6-sol', 'gpt-5.5']));
    const { app, stmts } = makeApp();

    const res = await request(app)
      .put('/api/sessions/sess-1/model')
      .send({ model: 'gpt-5.6-sol' })
      .expect(200);

    expect(stmts.updateSessionModel.run).toHaveBeenCalledWith('gpt-5.6-sol', 'sess-1');
    expect(res.body.model).toBe('gpt-5.6-sol');
  });

  it('resolves the capability cache from the session owner', async () => {
    readCodexModelsCacheForUser.mockReturnValue(cacheAdvertising(['gpt-5.6-sol']));
    const { app } = makeApp({ session: { owner_user_id: 'user-owner' } });

    await request(app).put('/api/sessions/sess-1/model').send({ model: 'gpt-5.6-sol' }).expect(200);

    expect(readCodexModelsCacheForUser).toHaveBeenCalledWith('user-owner', '/tmp/data');
  });

  it('rejects a 5.6 sibling the cache does not advertise', async () => {
    readCodexModelsCacheForUser.mockReturnValue(cacheAdvertising(['gpt-5.6-sol']));
    const { app, stmts } = makeApp();

    await request(app)
      .put('/api/sessions/sess-1/model')
      .send({ model: 'gpt-5.6-terra' })
      .expect(400);

    expect(stmts.updateSessionModel.run).not.toHaveBeenCalled();
  });

  it('still accepts a static baseline model when no cache is present', async () => {
    readCodexModelsCacheForUser.mockReturnValue(null);
    const { app, stmts } = makeApp();

    await request(app).put('/api/sessions/sess-1/model').send({ model: 'gpt-5.5' }).expect(200);

    expect(stmts.updateSessionModel.run).toHaveBeenCalledWith('gpt-5.5', 'sess-1');
  });
});

describe('PUT /api/sessions/:sessionId/model during a turn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readCodexModelsCacheForUser.mockReturnValue(null);
  });

  it('saves the selected model before interrupting with Continue', async () => {
    const { app, session, deps } = makeApp();
    deps.activeProcesses.set(session.id, { kind: 'guest', kill: vi.fn() });
    vi.mocked(deps.handleChat).mockImplementation(async () => {
      expect(session.model).toBe('gpt-5-codex');
    });

    await request(app).put('/api/sessions/sess-1/model').send({ model: 'gpt-5-codex' }).expect(200);

    expect(deps.handleChat).toHaveBeenCalledExactlyOnceWith(null, {
      type: 'chat',
      sessionId: session.id,
      agentId: session.agent_id,
      content: 'Continue',
      interrupt: true,
    } satisfies ChatMessage);
    expect(deps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session-updated',
        session: expect.objectContaining({ id: session.id, model: 'gpt-5-codex' }),
      }),
    );
  });

  it('also interrupts a turn that is preparing to spawn', async () => {
    const { app, stmts, deps } = makeApp();
    stmts.getActiveTask.get.mockReturnValue({ status: 'running', pid: null });

    await request(app).put('/api/sessions/sess-1/model').send({ model: 'gpt-5-codex' }).expect(200);

    expect(deps.handleChat).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ interrupt: true }),
    );
  });

  it('does not send Continue for an idle session', async () => {
    const { app, deps } = makeApp();
    await request(app).put('/api/sessions/sess-1/model').send({ model: 'gpt-5-codex' }).expect(200);
    expect(deps.handleChat).not.toHaveBeenCalled();
  });

  it('does not send Continue for a completed task row', async () => {
    const { app, stmts, deps } = makeApp();
    stmts.getActiveTask.get.mockReturnValue({ status: 'done', pid: null });
    await request(app).put('/api/sessions/sess-1/model').send({ model: 'gpt-5-codex' }).expect(200);
    expect(deps.handleChat).not.toHaveBeenCalled();
  });

  it('does not interrupt when the selected model is unchanged', async () => {
    const { app, session, deps } = makeApp();
    deps.activeProcesses.set(session.id, { kind: 'guest', kill: vi.fn() });
    await request(app).put('/api/sessions/sess-1/model').send({ model: session.model }).expect(200);
    expect(deps.handleChat).not.toHaveBeenCalled();
  });

  it('does not interrupt or save an invalid model', async () => {
    const { app, session, stmts, deps } = makeApp();
    deps.activeProcesses.set(session.id, { kind: 'guest', kill: vi.fn() });
    await request(app).put('/api/sessions/sess-1/model').send({ model: 'unknown' }).expect(400);
    expect(stmts.updateSessionModel.run).not.toHaveBeenCalled();
    expect(deps.handleChat).not.toHaveBeenCalled();
  });
});
