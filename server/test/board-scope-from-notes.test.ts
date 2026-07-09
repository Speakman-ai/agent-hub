import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import supertest from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import createBoardRoutes from '../routes/board.js';
import type { RouteDeps, Project, AgentLookup } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';

// ═══════════════════════════════════════════════════════════════════
// POST /board/scope-from-notes — opens a scoping-mode session seeded with
// free-form note content (a whole note or a heading-scoped block). Unlike the
// epic-linked scope route it is NOT tied to an epic and DOES auto-send a kickoff
// message so the agent immediately turns the notes into Epic → Phases → Tickets.
// Owner-gated, so we mount behind a stub-auth middleware (mirrors
// board-scope-epic.test.ts).
// ═══════════════════════════════════════════════════════════════════

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
  handleChat: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
}

function makeDeps(
  findAgent: (id: string) => AgentLookup | null,
  spies: Spies,
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
    createSession: { run: spies.createSession },
    updateSessionMode: { run: spies.updateSessionMode },
    updateSessionFinalizeAutomation: { run: () => {} },
    getSession: { get: (id: string) => ({ id, engine: 'claude-code', state: 'idle' }) },
  };
  return {
    findProject: (id: string) => (id === project.id ? project : null),
    findAgent,
    getEnrichedAgent: () => null,
    broadcast: spies.broadcast,
    stmts,
    handleChat: spies.handleChat,
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
  project: Project = PROJECT,
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).authRole = 'Owner';
    (req as AuthenticatedRequest).authUserId = 'test-user';
    next();
  });
  app.use(createBoardRoutes(makeDeps(findAgent, spies, project)));
  return supertest(app);
}

function makeSpies(): Spies {
  return {
    createSession: vi.fn(),
    updateSessionMode: vi.fn(),
    handleChat: vi.fn().mockResolvedValue(undefined),
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

const url = '/api/projects/proj-1/board/scope-from-notes';
const CONTENT = '## Templates\n- Cant apply to multiple states\n- Name has to be unique';

describe('POST /board/scope-from-notes', () => {
  it('creates a scoping-mode session and auto-sends the note content as a kickoff', async () => {
    const spies = makeSpies();
    const request = buildApp(localAgent, spies);

    const res = await request
      .post(url)
      .send({ content: CONTENT, title: 'Templates', agentId: 'local-agent' })
      .expect(200);
    const body = res.body as { sessionId: string; agentId: string };
    expect(body.sessionId).toBeTruthy();
    expect(body.agentId).toBe('local-agent');

    // Scoping mode is set (drives the scoping preamble in chat.ts) and NO epic
    // is linked (this route is not epic-bound).
    expect(spies.updateSessionMode).toHaveBeenCalledWith('scoping', body.sessionId);

    // The note content is auto-sent as the first turn (unlike the epic route).
    expect(spies.handleChat).toHaveBeenCalledTimes(1);
    const chatArgs = spies.handleChat.mock.calls[0][1] as { content: string; sessionId: string };
    expect(chatArgs.sessionId).toBe(body.sessionId);
    expect(chatArgs.content).toContain('Cant apply to multiple states');
    expect(chatArgs.content).toContain('Templates');

    expect(spies.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_created', agentId: 'local-agent' }),
    );
  });

  it('defaults to the project agent when no agentId is supplied', async () => {
    const spies = makeSpies();
    const request = buildApp(localAgent, spies);

    const res = await request.post(url).send({ content: CONTENT }).expect(200);
    const body = res.body as { agentId: string; sessionId: string };
    expect(body.agentId).toBe('local-agent');
    expect(spies.updateSessionMode).toHaveBeenCalledWith('scoping', body.sessionId);
  });

  it('returns 400 when content is empty', async () => {
    const spies = makeSpies();
    const request = buildApp(localAgent, spies);
    await request.post(url).send({ content: '' }).expect(400);
    expect(spies.createSession).not.toHaveBeenCalled();
    expect(spies.handleChat).not.toHaveBeenCalled();
  });

  it('returns 400 when the project has no agent to scope with', async () => {
    const spies = makeSpies();
    const emptyProject = { ...PROJECT, agents: [] } as unknown as Project;
    const request = buildApp(() => null, spies, emptyProject);
    const res = await request.post(url).send({ content: CONTENT }).expect(400);
    expect((res.body as { error: string }).error).toMatch(/no agent available/i);
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
    const res = await request
      .post(url)
      .send({ content: CONTENT, agentId: 'foreign-agent' })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/does not belong to this project/i);
    expect(spies.createSession).not.toHaveBeenCalled();
  });
});
