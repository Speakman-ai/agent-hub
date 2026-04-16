import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { Project, KanbanCardRow, KanbanEpicRow } from './types.js';

// ─── Module mocks (hoisted before imports) ────────────────────────────────

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn(() => ({ stop: vi.fn() })),
  },
  schedule: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock('./routes/board.js', () => ({
  getOrCreateBoard: vi.fn(),
}));

vi.mock('./routes/webhooks.js', () => ({
  notifyDispatchFailure: vi.fn(),
  dispatchReviewFeedback: vi.fn(),
}));

vi.mock('./config.js', () => ({
  defaultModelForEngine: vi.fn(() => 'mock-model'),
}));

const {
  initAutonomous,
  runAutonomousLoop,
  tryAutonomousDispatch,
  scheduleAutonomousEpic,
  autonomousProjects,
  autonomousCrons,
  lastDispatchedReviewId,
} = await import('./autonomous.js');

const { getOrCreateBoard } = await import('./routes/board.js');
const mockGetOrCreateBoard = getOrCreateBoard as Mock;

// ─── Helpers ──────────────────────────────────────────────────────────────

interface MockStmts {
  getAutonomousEpic: { get: Mock };
  getEligibleAutonomousCards: { all: Mock };
  getKanbanColumns: { all: Mock };
  getSession: { get: Mock };
  getKanbanCardsByEpic: { all: Mock };
  createSession: { run: Mock };
  updateKanbanCard: { run: Mock };
  moveKanbanCard: { run: Mock };
  incrementCardIterations: { run: Mock };
  createKanbanCardComment: { run: Mock };
}

function makeStmts(overrides: Partial<MockStmts> = {}): MockStmts {
  return {
    getAutonomousEpic: { get: vi.fn(() => null) },
    getEligibleAutonomousCards: { all: vi.fn(() => []) },
    getKanbanColumns: { all: vi.fn(() => []) },
    getSession: { get: vi.fn(() => null) },
    getKanbanCardsByEpic: { all: vi.fn(() => []) },
    createSession: { run: vi.fn() },
    updateKanbanCard: { run: vi.fn() },
    moveKanbanCard: { run: vi.fn() },
    incrementCardIterations: { run: vi.fn() },
    createKanbanCardComment: { run: vi.fn() },
    ...overrides,
  };
}

interface MockDeps {
  stmts: MockStmts;
  broadcast: Mock;
  findProject: Mock;
  findAgent: Mock;
  handleChat: Mock;
  handleCancel: Mock;
  getActiveProcesses: Mock;
  getProjects: Mock;
  getConfig: Mock;
  getGhAuthenticatedUser: Mock;
  getGhBotUser: Mock;
  getGhAppSlug: Mock;
  getWebhookHandlerDeps: Mock;
}

function makeDeps(stmts: MockStmts = makeStmts()): MockDeps {
  return {
    stmts,
    broadcast: vi.fn(),
    findProject: vi.fn(() => undefined),
    findAgent: vi.fn(() => null),
    handleChat: vi.fn(() => Promise.resolve()),
    handleCancel: vi.fn(),
    getActiveProcesses: vi.fn(() => new Map()),
    getProjects: vi.fn(() => []),
    getConfig: vi.fn(() => ({}) as never),
    getGhAuthenticatedUser: vi.fn(() => null),
    getGhBotUser: vi.fn(() => null),
    getGhAppSlug: vi.fn(() => null),
    getWebhookHandlerDeps: vi.fn(() => ({
      stmts,
      findAgent: vi.fn(),
      handleChat: vi.fn(),
      broadcast: vi.fn(),
    })),
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    cwd: '/tmp',
    ahw: '',
    agents: [
      { id: 'dev-1', name: 'Dev One', role: 'sub', engine: 'claude-code' },
      { id: 'dev-2', name: 'Dev Two', role: 'sub', engine: 'claude-code' },
    ],
    ...overrides,
  } as Project;
}

function makeCard(overrides: Partial<KanbanCardRow> = {}): KanbanCardRow {
  return {
    id: 'card-1',
    column_id: 'col-todo',
    title: 'Build feature',
    description: 'desc',
    position: 0,
    assignee: null,
    pr_url: null,
    epic_id: 'epic-1',
    session_id: null,
    autonomous_iterations: 0,
    priority: 'medium',
    labels: '',
    github_issue_url: null,
    ...overrides,
  } as unknown as KanbanCardRow;
}

const BOARD_COLS = [
  { id: 'col-todo', name: 'To Do' },
  { id: 'col-progress', name: 'In Progress' },
  { id: 'col-review', name: 'Review' },
  { id: 'col-done', name: 'Done' },
];

const ACTIVE_EPIC: KanbanEpicRow = {
  id: 'epic-1',
  board_id: 'board-1',
  name: 'Sprint 1',
  autonomous: 1,
  autonomous_max_concurrent: 3,
  autonomous_max_iterations: 5,
} as unknown as KanbanEpicRow;

beforeEach(() => {
  mockGetOrCreateBoard.mockReset();
  autonomousProjects.clear();
  for (const t of autonomousCrons.values()) t.stop?.();
  autonomousCrons.clear();
  lastDispatchedReviewId.clear();
});

// ═══════════════════════════════════════════════════════════════════════════
//  runAutonomousLoop — happy path dispatch
// ═══════════════════════════════════════════════════════════════════════════

describe('runAutonomousLoop — dispatch', () => {
  it('does nothing when project not found', async () => {
    const deps = makeDeps();
    initAutonomous(deps as never);
    await runAutonomousLoop('missing');
    expect(mockGetOrCreateBoard).not.toHaveBeenCalled();
  });

  it('does nothing when no autonomous epic', async () => {
    const stmts = makeStmts();
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(stmts.getEligibleAutonomousCards.all).not.toHaveBeenCalled();
    expect(deps.handleChat).not.toHaveBeenCalled();
  });

  it('does nothing when no eligible cards', async () => {
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => ACTIVE_EPIC) },
      getEligibleAutonomousCards: { all: vi.fn(() => []) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(deps.handleChat).not.toHaveBeenCalled();
  });

  it('assigns an eligible card to an available sub agent and creates a session', async () => {
    const card = makeCard();
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => ACTIVE_EPIC) },
      getEligibleAutonomousCards: { all: vi.fn(() => [card]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [card]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(stmts.incrementCardIterations.run).toHaveBeenCalledWith('card-1');
    expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
    expect(stmts.moveKanbanCard.run).toHaveBeenCalledWith('col-progress', 0, 'card-1');
    expect(deps.handleChat).toHaveBeenCalledTimes(1);
    const callArgs = deps.handleChat.mock.calls[0][1] as { content: string };
    expect(callArgs.content).toContain('Build feature');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  runAutonomousLoop — role exclusion
// ═══════════════════════════════════════════════════════════════════════════

describe('runAutonomousLoop — assignable agent filtering', () => {
  it('excludes reviewer, docs, and intake roles from assignment pool', async () => {
    const card = makeCard();
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => ACTIVE_EPIC) },
      getEligibleAutonomousCards: { all: vi.fn(() => [card]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [card]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(
      makeProject({
        agents: [
          { id: 'reviewer-1', name: 'Reviewer', role: 'reviewer', engine: 'claude-code' },
          { id: 'docs-1', name: 'Docs', role: 'docs', engine: 'claude-code' },
          { id: 'intake-1', name: 'Intake', role: 'intake', engine: 'claude-code' },
          { id: 'dev-1', name: 'Dev', role: 'sub', engine: 'claude-code' },
        ],
      }),
    );
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
    const sessionArgs = stmts.createSession.run.mock.calls[0];
    expect(sessionArgs[1]).toBe('dev-1');
  });

  it('logs a notice and skips dispatch when no assignable agents exist', async () => {
    const card = makeCard();
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => ACTIVE_EPIC) },
      getEligibleAutonomousCards: { all: vi.fn(() => [card]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(
      makeProject({
        agents: [
          { id: 'reviewer-1', name: 'Reviewer', role: 'reviewer', engine: 'claude-code' },
          { id: 'docs-1', name: 'Docs', role: 'docs', engine: 'claude-code' },
        ],
      }),
    );
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(deps.handleChat).not.toHaveBeenCalled();
    expect(stmts.createKanbanCardComment.run).toHaveBeenCalledTimes(1);
    const commentArgs = stmts.createKanbanCardComment.run.mock.calls[0];
    expect(commentArgs[3]).toMatch(/Autonomous dispatch skipped/);
  });

  it('respects lead.subAgents config when set', async () => {
    const card = makeCard();
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => ACTIVE_EPIC) },
      getEligibleAutonomousCards: { all: vi.fn(() => [card]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [card]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(
      makeProject({
        agents: [
          {
            id: 'lead-1',
            name: 'Lead',
            role: 'lead',
            engine: 'claude-code',
            subAgents: ['dev-2'],
          },
          { id: 'dev-1', name: 'Dev One', role: 'sub', engine: 'claude-code' },
          { id: 'dev-2', name: 'Dev Two', role: 'sub', engine: 'claude-code' },
        ] as never,
      }),
    );
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
    const sessionArgs = stmts.createSession.run.mock.calls[0];
    expect(sessionArgs[1]).toBe('dev-2');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  runAutonomousLoop — concurrency limits
// ═══════════════════════════════════════════════════════════════════════════

describe('runAutonomousLoop — concurrency', () => {
  it('respects autonomous_max_concurrent across in-progress + review cards', async () => {
    const epic = {
      ...ACTIVE_EPIC,
      autonomous_max_concurrent: 1,
    } as unknown as KanbanEpicRow;
    const card = makeCard();
    const inProgressCard = makeCard({ id: 'card-2', column_id: 'col-progress' });
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => epic) },
      getEligibleAutonomousCards: { all: vi.fn(() => [card]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [card, inProgressCard]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(stmts.createSession.run).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  scheduleAutonomousEpic + tryAutonomousDispatch
// ═══════════════════════════════════════════════════════════════════════════

describe('scheduleAutonomousEpic', () => {
  it('adds project id to autonomousProjects and schedules cron when autonomous=1', () => {
    const deps = makeDeps();
    deps.findProject.mockReturnValue(undefined);
    initAutonomous(deps as never);

    scheduleAutonomousEpic('proj-1', ACTIVE_EPIC);

    expect(autonomousProjects.has('proj-1')).toBe(true);
    expect(autonomousCrons.has(ACTIVE_EPIC.id)).toBe(true);
  });

  it('removes project id and cron when autonomous=0', () => {
    const deps = makeDeps();
    initAutonomous(deps as never);

    scheduleAutonomousEpic('proj-1', ACTIVE_EPIC);
    expect(autonomousProjects.has('proj-1')).toBe(true);

    const inactive = { ...ACTIVE_EPIC, autonomous: 0 } as unknown as KanbanEpicRow;
    scheduleAutonomousEpic('proj-1', inactive);

    expect(autonomousProjects.has('proj-1')).toBe(false);
    expect(autonomousCrons.has(ACTIVE_EPIC.id)).toBe(false);
  });
});

describe('tryAutonomousDispatch', () => {
  it('runs runAutonomousLoop for every project in autonomousProjects', () => {
    const deps = makeDeps();
    initAutonomous(deps as never);

    autonomousProjects.add('proj-a');
    autonomousProjects.add('proj-b');

    tryAutonomousDispatch();

    expect(deps.findProject).toHaveBeenCalledWith('proj-a');
    expect(deps.findProject).toHaveBeenCalledWith('proj-b');
  });

  it('is a no-op when no projects are autonomous', () => {
    const deps = makeDeps();
    initAutonomous(deps as never);

    tryAutonomousDispatch();

    expect(deps.findProject).not.toHaveBeenCalled();
  });
});
