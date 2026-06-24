import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import supertest from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import createBoardRoutes from '../routes/board.js';
import type { RouteDeps, Project, AgentLookup } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';

// ═══════════════════════════════════════════════════════════════════
// POST /board/epics/:epicId/scope — opens a scoping-mode session that is
// pre-linked to the epic, so the scoping preamble (chat.ts) injects the
// epic, its phases, spec items, and locked decisions on the first turn
// and the agent knows which epic without being told. Owner-gated, so we
// mount the board router behind a stub-auth middleware that supplies an
// authUserId (mirrors board-decide-for-me-agent.test.ts).
// ═══════════════════════════════════════════════════════════════════

const EPIC = {
  id: 'epic-1',
  board_id: 'board-1',
  name: 'Billing revamp',
  description: null,
  color: null,
};

const PROJECT: Project = {
  id: 'proj-1',
  name: 'Project One',
  cwd: '/tmp',
  ahw: '',
  agents: [{ id: 'local-agent', name: 'Local', role: 'sub', engine: 'claude-code' }],
} as unknown as Project;

interface Spies {
  createSession: ReturnType<typeof vi.fn>;
  updateSessionMode: ReturnType<typeof vi.fn>;
  updateSessionLinkedEpic: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
}

function makeDeps(
  findAgent: (id: string) => AgentLookup | null,
  spies: Spies,
  epic: typeof EPIC | null = EPIC,
  project: Project = PROJECT,
): RouteDeps {
  const empty = { all: () => [] };
  const stmts = {
    getKanbanBoard: { get: () => ({ id: 'board-1' }) },
    getKanbanColumns: empty,
    getKanbanCards: empty,
    getKanbanEpics: empty,
    getKanbanPhases: empty,
    getKanbanSpecItems: empty,
    getKanbanEpic: { get: () => (epic ? { ...epic } : undefined) },
    createSession: { run: spies.createSession },
    updateSessionMode: { run: spies.updateSessionMode },
    updateSessionLinkedEpic: { run: spies.updateSessionLinkedEpic },
    updateSessionFinalizeAutomation: { run: () => {} },
    getSession: { get: (id: string) => ({ id, engine: 'claude-code', state: 'idle' }) },
  };
  return {
    findProject: (id: string) => (id === project.id ? project : null),
    findAgent,
    getEnrichedAgent: () => null,
    broadcast: spies.broadcast,
    stmts,
    handleChat: () => Promise.resolve(),
    lastDispatchedReviewId: new Map(),
    scheduleAutonomousEpic: () => {},
    autonomousCrons: new Map(),
    runAutonomousLoop: () => Promise.resolve(),
    config: { engineValidModels: {}, engineDefaultModels: {} },
  } as unknown as RouteDeps;
}

function buildApp(
  findAgent: (id: string) => AgentLookup | null,
  spies: Spies,
  epic: typeof EPIC | null = EPIC,
  project: Project = PROJECT,
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).authRole = 'Owner';
    (req as AuthenticatedRequest).authUserId = 'test-user';
    next();
  });
  app.use(createBoardRoutes(makeDeps(findAgent, spies, epic, project)));
  return supertest(app);
}

function makeSpies(): Spies {
  return {
    createSession: vi.fn(),
    updateSessionMode: vi.fn(),
    updateSessionLinkedEpic: vi.fn(),
    broadcast: vi.fn(),
  };
}

const localAgent = (id: string): AgentLookup | null =>
  id === 'local-agent'
    ? ({
        project: PROJECT,
        agent: { id: 'local-agent', name: 'Local', engine: 'claude-code', model: null },
      } as unknown as AgentLookup)
    : null;

const url = '/api/projects/proj-1/board/epics/epic-1/scope';

describe('POST /board/epics/:epicId/scope', () => {
  it('creates a scoping-mode session linked to the epic', async () => {
    const spies = makeSpies();
    const request = buildApp(localAgent, spies);

    const res = await request.post(url).send({ agentId: 'local-agent' }).expect(200);
    const body = res.body as { sessionId: string; agentId: string };
    expect(body.sessionId).toBeTruthy();
    expect(body.agentId).toBe('local-agent');

    // Mode is scoping and the session is linked to the epic — the two facts
    // the scoping preamble relies on to inject epic context.
    expect(spies.updateSessionMode).toHaveBeenCalledWith('scoping', body.sessionId);
    expect(spies.updateSessionLinkedEpic).toHaveBeenCalledWith('epic-1', body.sessionId);
    // No kickoff chat message — the user types their own first request.
    expect(spies.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_created', agentId: 'local-agent' }),
    );
  });

  it('defaults to the project agent when no agentId is supplied (the web/mobile path)', async () => {
    // Both clients call api.scopeEpic(projectId, epicId) with no agentId, so the
    // route must resolve a default via pickDefaultDecideAgent — the primary
    // production path. PROJECT's only agent (role 'sub') is the fallback pick.
    const spies = makeSpies();
    const request = buildApp(localAgent, spies);

    const res = await request.post(url).send({}).expect(200);
    const body = res.body as { sessionId: string; agentId: string };
    expect(body.agentId).toBe('local-agent');
    expect(spies.updateSessionMode).toHaveBeenCalledWith('scoping', body.sessionId);
    expect(spies.updateSessionLinkedEpic).toHaveBeenCalledWith('epic-1', body.sessionId);
  });

  it('returns 400 when the project has no agent to scope with', async () => {
    const spies = makeSpies();
    const emptyProject = { ...PROJECT, agents: [] } as unknown as Project;
    const request = buildApp(() => null, spies, EPIC, emptyProject);
    const res = await request.post(url).send({}).expect(400);
    expect((res.body as { error: string }).error).toMatch(/no agent available/i);
    expect(spies.createSession).not.toHaveBeenCalled();
  });

  it('returns 404 when the epic does not exist', async () => {
    const spies = makeSpies();
    const request = buildApp(localAgent, spies, null);
    await request.post(url).send({}).expect(404);
    expect(spies.createSession).not.toHaveBeenCalled();
  });

  it('rejects an explicit agentId that belongs to a different project', async () => {
    const spies = makeSpies();
    const request = buildApp(
      (id) =>
        id === 'foreign-agent'
          ? ({
              project: { id: 'other-proj' } as Project,
              agent: { id: 'foreign-agent', name: 'Foreign', engine: 'claude-code' },
            } as unknown as AgentLookup)
          : null,
      spies,
    );
    const res = await request.post(url).send({ agentId: 'foreign-agent' }).expect(400);
    expect((res.body as { error: string }).error).toMatch(/does not belong to this project/i);
    expect(spies.createSession).not.toHaveBeenCalled();
  });
});
