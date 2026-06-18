import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteDeps, SessionRow } from '../types.js';

const { default: createSessionRoutes } = await import('./sessions.js');

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    agent_id: 'agent-1',
    name: 'Codex session',
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
    reasoning_effort: null,
    cron_id: null,
    created_at: '2026-06-18 17:00:00',
    updated_at: '2026-06-18 17:00:00',
    deleted_at: null,
    finalize_automation: 'manual',
    state: 'waiting_for_user_input',
    ...overrides,
  } as SessionRow;
}

function makeApp(options: { session?: Partial<SessionRow>; missing?: boolean } = {}) {
  const session = makeSession(options.session);
  const stmts = {
    updateSessionReasoningEffort: {
      run: vi.fn((effort: string) => {
        session.reasoning_effort = effort;
      }),
    },
    getSession: { get: vi.fn(() => (options.missing ? undefined : session)) },
    getSessionAgents: { all: vi.fn(() => []) },
    getKanbanCardBySession: { get: vi.fn(() => undefined) },
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
    broadcast: vi.fn(),
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use(createSessionRoutes(deps));
  return { app, session, stmts };
}

describe('PUT /api/sessions/:sessionId/reasoning-effort', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['high', 'pro'] as const)('persists the %s preset', async (effort) => {
    const { app, stmts } = makeApp();

    const res = await request(app)
      .put('/api/sessions/sess-1/reasoning-effort')
      .send({ effort })
      .expect(200);

    expect(stmts.updateSessionReasoningEffort.run).toHaveBeenCalledWith(effort, 'sess-1');
    expect(res.body.reasoning_effort).toBe(effort);
  });

  it('rejects an invalid effort with 400 and does not write', async () => {
    const { app, stmts } = makeApp();

    await request(app)
      .put('/api/sessions/sess-1/reasoning-effort')
      .send({ effort: 'xhigh' }) // native level name, not an accepted preset
      .expect(400);

    expect(stmts.updateSessionReasoningEffort.run).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown session', async () => {
    const { app, stmts } = makeApp({ missing: true });

    await request(app)
      .put('/api/sessions/nope/reasoning-effort')
      .send({ effort: 'pro' })
      .expect(404);

    expect(stmts.updateSessionReasoningEffort.run).not.toHaveBeenCalled();
  });
});
