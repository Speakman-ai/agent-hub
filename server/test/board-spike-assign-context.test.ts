import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import supertest from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import createBoardRoutes from '../routes/board.js';
import type { RouteDeps, Project, KanbanCardRow, KanbanEpicSpecItemRow } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';

// ═══════════════════════════════════════════════════════════════════
// POST /board/cards/:cardId/assign — first-message context for a spike
// card. The session is created in scoping mode (no worktree, manual
// finalize), so its first message must be spike/research instructions —
// even when the spike has no linked spec item, where it previously fell
// back to the implementation prompt ("# Task: …"). Mirror autonomous
// dispatch's fallback.
// ═══════════════════════════════════════════════════════════════════

function buildApp(card: Partial<KanbanCardRow>, specItem?: KanbanEpicSpecItemRow) {
  const captured: { content: string } = { content: '' };
  const handleChat = vi.fn((_caller: unknown, payload: { content?: string }) => {
    captured.content = payload?.content ?? '';
    return Promise.resolve();
  });
  const noop = { run: () => {} };
  const fullCard = {
    id: 'card-1',
    column_id: 'col-todo',
    board_id: 'board-1',
    title: 'Spike: choose chat transport',
    description: null,
    priority: 'medium',
    labels: null,
    epic_id: null,
    phase_id: null,
    session_id: null,
    card_kind: 'spike',
    auto_merge: null,
    ...card,
  } as unknown as KanbanCardRow;
  const sessionRow = {
    id: 'sess-1',
    agent_id: 'agent-1',
    name: fullCard.title,
    engine: 'claude-code',
    model: 'claude-x',
  };
  const stmts = {
    getKanbanCard: { get: () => fullCard },
    getKanbanSpecItemBySpikeCard: { get: () => specItem },
    createSession: noop,
    updateSessionMode: noop,
    updateSessionFinalizeAutomation: noop,
    updateSessionAutoShipOnComplete: noop,
    updateSessionLinkedEpic: noop,
    updateSessionLinkedSpecItem: noop,
    getKanbanBoard: { get: () => ({ id: 'board-1' }) },
    getKanbanColumns: { all: () => [{ id: 'col-prog', name: 'In Progress' }] },
    updateKanbanCard: noop,
    moveKanbanCard: noop,
    setKanbanCardAssignedUser: noop,
    setKanbanCardAutoMerge: noop,
    createKanbanCardComment: noop,
    getSession: { get: () => sessionRow },
  };
  const project: Project = {
    id: 'proj-1',
    name: 'P',
    cwd: '/tmp',
    ahw: '',
    agents: [{ id: 'agent-1', name: 'Dev', role: 'sub', engine: 'claude-code' }],
  } as unknown as Project;
  const deps = {
    findProject: (id: string) => (id === 'proj-1' ? project : null),
    findAgent: (id: string) => (id === 'agent-1' ? { project, agent: project.agents![0] } : null),
    getEnrichedAgent: () => null,
    broadcast: () => {},
    stmts,
    handleChat,
    lastDispatchedReviewId: new Map(),
    scheduleAutonomousEpic: () => {},
    autonomousCrons: new Map(),
    runAutonomousLoop: () => Promise.resolve(),
    config: {
      engineValidModels: { 'claude-code': ['claude-x'] },
      engineDefaultModels: { 'claude-code': 'claude-x' },
    },
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).authRole = 'Owner';
    (req as AuthenticatedRequest).authUserId = 'u1';
    next();
  });
  app.use(createBoardRoutes(deps));
  return { request: supertest(app), captured };
}

const url = '/api/projects/proj-1/board/cards/card-1/assign';

describe('board assign — spike card first-message context', () => {
  it('uses the spike/research fallback for a spike card with no linked spec item', async () => {
    const { request, captured } = buildApp({ card_kind: 'spike', epic_id: null });
    await request.post(url).send({ agentId: 'agent-1' }).expect(200);

    // Spike planning instructions, NOT the implementation prompt.
    expect(captured.content).toMatch(/spike session/i);
    expect(captured.content).toMatch(/no code/i);
    expect(captured.content).not.toMatch(/^# Task:/m);
    expect(captured.content).not.toMatch(/begin working on it/i);
  });

  it('still uses the normal implementation prompt for a non-spike card', async () => {
    const { request, captured } = buildApp({
      card_kind: 'task',
      title: 'Implement login',
      epic_id: null,
    });
    await request.post(url).send({ agentId: 'agent-1' }).expect(200);

    expect(captured.content).toMatch(/^# Task:/m);
    expect(captured.content).not.toMatch(/spike session/i);
  });
});
