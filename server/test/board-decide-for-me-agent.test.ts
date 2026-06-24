import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import supertest from 'supertest';
import { describe, it, expect } from 'vitest';
import createBoardRoutes from '../routes/board.js';
import type { RouteDeps, Project, AgentLookup } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';

// ═══════════════════════════════════════════════════════════════════
// POST /board/spec-items/:id/decide-for-me — explicit agent must belong
// to the project (board.ts). This route is owner-gated, so the shared
// integration app (which never sets authUserId) can't reach the agent
// check; we mount the board router behind a stub-auth middleware.
// ═══════════════════════════════════════════════════════════════════

const SPEC_ITEM = {
  id: 'spec-1',
  board_id: 'board-1',
  epic_id: 'epic-1',
  phase_id: null,
  tag: 'CHOOSE',
  title: 'pick a thing',
  decision: null,
  status: 'open',
  position: 0,
  resolved_session_id: null,
};

const PROJECT: Project = {
  id: 'proj-1',
  name: 'Project One',
  cwd: '/tmp',
  ahw: '',
  agents: [{ id: 'local-agent', name: 'Local', role: 'sub', engine: 'claude-code' }],
} as unknown as Project;

function makeDeps(findAgent: (id: string) => AgentLookup | null): RouteDeps {
  const empty = { all: () => [] };
  const stmts = {
    getKanbanBoard: { get: () => ({ id: 'board-1' }) },
    getKanbanColumns: empty,
    getKanbanCards: empty,
    getKanbanEpics: empty,
    getKanbanPhases: empty,
    getKanbanSpecItems: empty,
    getKanbanSpecItem: { get: () => ({ ...SPEC_ITEM }) },
  };
  return {
    findProject: (id: string) => (id === PROJECT.id ? PROJECT : null),
    findAgent,
    getEnrichedAgent: () => null,
    broadcast: () => {},
    stmts,
    handleChat: () => Promise.resolve(),
    lastDispatchedReviewId: new Map(),
    scheduleAutonomousEpic: () => {},
    autonomousCrons: new Map(),
    runAutonomousLoop: () => Promise.resolve(),
    config: { engineValidModels: {}, engineDefaultModels: {} },
  } as unknown as RouteDeps;
}

function buildApp(findAgent: (id: string) => AgentLookup | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).authRole = 'Owner';
    (req as AuthenticatedRequest).authUserId = 'test-user';
    next();
  });
  app.use(createBoardRoutes(makeDeps(findAgent)));
  return supertest(app);
}

const url = '/api/projects/proj-1/board/spec-items/spec-1/decide-for-me';

describe('decide-for-me — agent project membership', () => {
  it('rejects an explicit agentId that belongs to a different project', async () => {
    const request = buildApp((id) =>
      id === 'foreign-agent'
        ? ({
            project: { id: 'other-proj' } as Project,
            agent: { id: 'foreign-agent', name: 'Foreign', engine: 'claude-code' },
          } as unknown as AgentLookup)
        : null,
    );
    const res = await request.post(url).send({ agentId: 'foreign-agent' }).expect(400);
    expect((res.body as { error: string }).error).toMatch(/does not belong to this project/i);
  });

  it('rejects an explicit agentId that resolves to no agent', async () => {
    const request = buildApp(() => null);
    const res = await request.post(url).send({ agentId: 'ghost-agent' }).expect(400);
    expect((res.body as { error: string }).error).toMatch(/does not belong to this project/i);
  });

  it('does not apply the membership guard when no agentId is supplied', async () => {
    // With no explicit agent, the route skips the membership guard and falls
    // through to the default-pick path, failing there with a *different* error
    // — proving the guard is scoped to explicit agent selection only.
    const request = buildApp(() => null);
    const res = await request.post(url).send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((res.body as { error?: string }).error ?? '').not.toMatch(
      /does not belong to this project/i,
    );
  });
});
