/**
 * Ownership guard for POST /api/sessions/:sessionId/extract-skill.
 *
 * The route reads a session's full transcript and spawns a new owned session
 * from it, so a caller who is not allowed to see the source session must be
 * refused BEFORE the transcript is read — otherwise the endpoint exfiltrates
 * another user's transcript. We mock `userCanReadSession` to deny and assert
 * the handler 404s without reading messages or spawning the coach.
 *
 * Kept in its own file so the module-level `vi.mock` (which forces the
 * predicate false for every test here) doesn't affect the happy-path harness
 * in `sessions.extract-skill.test.ts`, which runs with auth disabled (the
 * predicate is permissive there).
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteDeps, SessionRow } from '../types.js';

vi.mock('../session-ownership.js', async () => {
  const actual =
    await vi.importActual<typeof import('../session-ownership.js')>('../session-ownership.js');
  return {
    ...actual,
    userCanReadSession: vi.fn(() => false),
    userOwnsSession: vi.fn(() => false),
  };
});

const { default: createSessionRoutes } = await import('./sessions.js');

function makeSession(): SessionRow {
  return {
    id: 'src-1',
    agent_id: 'dev-1',
    name: 'Someone else session',
    engine: 'claude-code',
    model: 'claude-sonnet-4-6',
    use_worktree: 1,
    ask_mode: 0,
    state: 'waiting_for_user_input',
  } as SessionRow;
}

function makeApp() {
  const handleChat = vi.fn().mockResolvedValue(undefined);
  const stmts = {
    getSession: { get: vi.fn(() => makeSession()) },
    getMessages: { all: vi.fn(() => [{ role: 'user', content: 'secret', agent_name: null }]) },
    getSessionAgents: { all: vi.fn(() => []) },
    createSession: { run: vi.fn() },
  };
  const deps = {
    stmts,
    config: { publicUrl: null },
    handleChat,
    broadcast: vi.fn(),
    findAgent: vi.fn(() => ({
      agent: { id: 'dev-1', role: 'dev', name: 'Dev' },
      project: {
        id: 'agent-hub',
        name: 'agent-hub',
        agents: [
          { id: 'dev-1', role: 'dev' },
          { id: 'sb', role: 'skill-builder' },
        ],
      },
    })),
    getEnrichedAgent: vi.fn(() => ({ id: 'x', name: 'x', color: '#333', role: 'dev' })),
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use(createSessionRoutes(deps));
  return { app, stmts, handleChat };
}

describe('POST /api/sessions/:sessionId/extract-skill — ownership guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('404s a caller who cannot read the source session, without reading it or spawning', async () => {
    const { app, stmts, handleChat } = makeApp();

    await request(app).post('/api/sessions/src-1/extract-skill').expect(404);

    // Transcript never read; coach never spawned.
    expect(stmts.getMessages.all).not.toHaveBeenCalled();
    expect(stmts.createSession.run).not.toHaveBeenCalled();
    expect(handleChat).not.toHaveBeenCalled();
  });
});
