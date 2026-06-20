/**
 * Route tests for POST /api/sessions/:sessionId/extract-skill
 * (Skill Builder Phase 4 — "turn this session into a skill").
 *
 * Mocks all deps; never spawns a real CLI (handleChat is a vi.fn). Asserts the
 * coach session is created against the project's skill-builder agent, the
 * transcript is handed to handleChat, and the error paths return the right
 * status codes.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteDeps, SessionRow, MessageRow } from '../types.js';

const { default: createSessionRoutes } = await import('./sessions.js');

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'src-1',
    agent_id: 'dev-1',
    name: 'Deploy staging walkthrough',
    engine: 'claude-code',
    model: 'claude-sonnet-4-6',
    engine_session_id: null,
    use_worktree: 1,
    worktree_path: '/tmp/wt',
    worktree_branch: 'feature/x',
    git_worktree_detected: 1,
    changes_ready: null,
    stale_pr_notified_at: null,
    ask_mode: 0,
    reasoning_effort: null,
    cron_id: null,
    created_at: '2026-06-20 00:00:00',
    updated_at: '2026-06-20 00:00:00',
    deleted_at: null,
    finalize_automation: 'manual',
    state: 'waiting_for_user_input',
    ...overrides,
  } as SessionRow;
}

const MESSAGES: MessageRow[] = [
  { role: 'user', content: 'how do I deploy staging', agent_name: null } as MessageRow,
  { role: 'assistant', content: 'run these steps', agent_name: null } as MessageRow,
];

function makeApp(
  options: {
    sourceMissing?: boolean;
    messages?: MessageRow[];
    agents?: Array<{ id: string; role: string; engine?: string; model?: string; name?: string }>;
    projectMissing?: boolean;
  } = {},
) {
  const source = makeSession();
  const createdRows: Record<string, SessionRow> = {};

  const agents = options.agents ?? [
    { id: 'dev-1', role: 'dev', name: 'Agent Hub Dev', engine: 'claude-code' },
    { id: 'agent-hub-skill-builder', role: 'skill-builder', name: 'Skill Builder' },
  ];
  const project = options.projectMissing
    ? undefined
    : { id: 'agent-hub', name: 'agent-hub', agents };

  const handleChat = vi.fn().mockResolvedValue(undefined);
  const broadcast = vi.fn();

  const stmts = {
    getSession: {
      get: vi.fn((id: string) => {
        if (id === 'src-1') return options.sourceMissing ? undefined : source;
        return createdRows[id];
      }),
    },
    getMessages: { all: vi.fn(() => options.messages ?? MESSAGES) },
    getSessionAgents: { all: vi.fn(() => []) },
    getKanbanCardBySession: { get: vi.fn(() => undefined) },
    createSession: {
      run: vi.fn(
        (
          id: string,
          agentId: string,
          name: string,
          engine: string,
          model: string,
          useWorktree: number,
          askMode: number,
        ) => {
          createdRows[id] = makeSession({
            id,
            agent_id: agentId,
            name,
            engine,
            model,
            use_worktree: useWorktree,
            ask_mode: askMode,
          });
        },
      ),
    },
  };

  const deps = {
    stmts,
    config: { publicUrl: null, defaultModel: 'claude-sonnet-4-6' },
    handleChat,
    broadcast,
    findAgent: vi.fn((agentId: string) => {
      if (!project) return undefined;
      const agent = project.agents.find((a) => a.id === agentId);
      if (!agent) return undefined;
      return { agent, project };
    }),
    getEnrichedAgent: vi.fn(() => ({ id: 'x', name: 'x', color: '#333', role: 'dev' })),
  } as unknown as RouteDeps;

  const app = express();
  app.use(express.json());
  app.use(createSessionRoutes(deps));
  return { app, stmts, handleChat, broadcast };
}

describe('POST /api/sessions/:sessionId/extract-skill', () => {
  beforeEach(() => vi.clearAllMocks());

  it('spawns a skill-builder coach session and hands it the transcript', async () => {
    const { app, stmts, handleChat, broadcast } = makeApp();

    const res = await request(app).post('/api/sessions/src-1/extract-skill').expect(201);

    expect(res.body.agentId).toBe('agent-hub-skill-builder');
    expect(res.body.sessionId).toBeTruthy();

    // Coach session created against the skill-builder agent, no worktree.
    expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
    const args = stmts.createSession.run.mock.calls[0];
    expect(args[1]).toBe('agent-hub-skill-builder'); // agent id
    expect(args[2]).toBe('[Skill from] Deploy staging walkthrough'); // name
    expect(args[5]).toBe(0); // use_worktree = 0

    // Transcript handed to the coach's first turn.
    expect(handleChat).toHaveBeenCalledTimes(1);
    const chatMsg = handleChat.mock.calls[0][1];
    expect(chatMsg.agentId).toBe('agent-hub-skill-builder');
    expect(chatMsg.content).toContain('how do I deploy staging');
    expect(chatMsg.content).toContain('skill-creator');

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_created', agentId: 'agent-hub-skill-builder' }),
    );
  });

  it('404s when the source session is missing', async () => {
    const { app, handleChat } = makeApp({ sourceMissing: true });
    await request(app).post('/api/sessions/src-1/extract-skill').expect(404);
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('400s when the session has no messages', async () => {
    const { app, handleChat } = makeApp({ messages: [] });
    await request(app).post('/api/sessions/src-1/extract-skill').expect(400);
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('400s when the project has no skill-builder coach agent', async () => {
    const { app, handleChat } = makeApp({
      agents: [{ id: 'dev-1', role: 'dev', name: 'Agent Hub Dev' }],
    });
    const res = await request(app).post('/api/sessions/src-1/extract-skill').expect(400);
    expect(res.body.error).toBe('skill_builder_missing');
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('400s when the source session has no resolvable project', async () => {
    const { app, handleChat } = makeApp({ projectMissing: true });
    await request(app).post('/api/sessions/src-1/extract-skill').expect(400);
    expect(handleChat).not.toHaveBeenCalled();
  });
});
