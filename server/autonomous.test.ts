import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { Project, KanbanCardRow, KanbanEpicRow, SessionRow } from './types.js';

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
  dispatchReviewFeedback: vi
    .fn()
    .mockResolvedValue({ sessionId: null, userMessagePersisted: true }),
}));

vi.mock('./config.js', () => ({
  default: { apiKey: null },
  defaultModelForEngine: vi.fn(() => 'mock-model'),
}));

vi.mock('./session-ownership.js', () => ({
  setSessionOwner: vi.fn(),
  getOrgOwnerUserId: vi.fn(() => null),
  inheritOwnerFromSession: vi.fn(),
  resolveOwnerUserId: vi.fn(() => null),
  resolveAutonomousOwnerUserId: vi.fn(() => null),
  userOwnsSession: vi.fn(() => true),
}));

// ─── Secrets mock (controls cross-hub label gate) ─────────────────────────
// Use the real `cardNeedsDevHubKey` so the label set in secrets.ts is the
// single source of truth — the test never re-implements the matching logic.
// Only `getDevHubApiKey` is stubbed so no AWS calls are made during tests.
vi.mock('./secrets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secrets.js')>();
  return {
    ...actual,
    getDevHubApiKey: vi.fn(async () => 'ahub_mock_dev_key'),
  };
});

const {
  initAutonomous,
  runAutonomousLoop,
  tryAutonomousDispatch,
  scheduleAutonomousEpic,
  autonomousProjects,
  autonomousCrons,
  lastDispatchedReviewId,
  lastBlockerSkipSignature,
  isPrMergeDirty,
} = await import('./autonomous.js');

const { getOrCreateBoard } = await import('./routes/board.js');
const mockGetOrCreateBoard = getOrCreateBoard as Mock;

const { getDevHubApiKey: mockGetDevHubApiKey } = await import('./secrets.js');
const mockGetDevHubApiKeyFn = mockGetDevHubApiKey as Mock;

// ─── Helpers ──────────────────────────────────────────────────────────────

interface MockStmts {
  getAutonomousEpic: { get: Mock };
  getEligibleAutonomousCards: { all: Mock };
  getKanbanColumns: { all: Mock };
  getSession: { get: Mock };
  getKanbanCardsByEpic: { all: Mock };
  getKanbanEpic: { get: Mock };
  updateKanbanEpic: { run: Mock };
  createSession: { run: Mock };
  updateKanbanCard: { run: Mock };
  moveKanbanCard: { run: Mock };
  markCardDispatchedByAutonomous: { run: Mock };
  createKanbanCardComment: { run: Mock };
  // Blocker enrichment (loadBoardBlockers → getBlockersForBoard; default
  // empty so existing tests don't have to know about this edge).
  getBlockersForBoard: { all: Mock };
  getBlockersForCard: { all: Mock };
}

function makeStmts(overrides: Partial<MockStmts> = {}): MockStmts {
  return {
    getAutonomousEpic: { get: vi.fn(() => null) },
    getEligibleAutonomousCards: { all: vi.fn(() => []) },
    getKanbanColumns: { all: vi.fn(() => []) },
    getSession: { get: vi.fn(() => null) },
    getKanbanCardsByEpic: { all: vi.fn(() => []) },
    getKanbanEpic: { get: vi.fn() },
    updateKanbanEpic: { run: vi.fn() },
    createSession: { run: vi.fn() },
    updateKanbanCard: { run: vi.fn() },
    moveKanbanCard: { run: vi.fn() },
    markCardDispatchedByAutonomous: { run: vi.fn() },
    createKanbanCardComment: { run: vi.fn() },
    getBlockersForBoard: { all: vi.fn(() => []) },
    getBlockersForCard: { all: vi.fn(() => []) },
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
  getDb: Mock;
}

/**
 * Build a minimal stand-in for better-sqlite3's `db.transaction()` API. The
 * production code calls `db.transaction(fn).immediate(...args)` to wrap the
 * slot-claim under `BEGIN IMMEDIATE`. In-process tests don't have a real
 * connection — we just invoke `fn` synchronously so the call sites exercise
 * the same code path without needing a sqlite instance.
 */
function makeFakeDb(): { transaction: (fn: (...args: unknown[]) => unknown) => unknown } {
  return {
    transaction: (fn: (...args: unknown[]) => unknown) => {
      const wrap = ((...args: unknown[]) => fn(...args)) as unknown as Record<string, unknown>;
      wrap.immediate = (...args: unknown[]) => fn(...args);
      wrap.deferred = (...args: unknown[]) => fn(...args);
      wrap.exclusive = (...args: unknown[]) => fn(...args);
      return wrap;
    },
  };
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
    getDb: vi.fn(() => makeFakeDb()),
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
    dispatched_by_autonomous: 0,
    priority: 'medium',
    labels: '',
    github_issue_url: null,
    triaged_at: null,
    triaged_by: null,
    suggested_assignee: null,
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
  autonomous_model: null,
} as unknown as KanbanEpicRow;

beforeEach(() => {
  mockGetOrCreateBoard.mockReset();
  autonomousProjects.clear();
  for (const t of autonomousCrons.values()) t.stop?.();
  autonomousCrons.clear();
  lastDispatchedReviewId.clear();
  lastBlockerSkipSignature.clear();
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

  it('disables autonomous when every card in the epic is Done', async () => {
    const epic: KanbanEpicRow = {
      ...ACTIVE_EPIC,
      description: 'd',
      color: '#fff',
      autonomous_interval: 5,
      orchestration_budgets_json: null,
      pr_base_branch: 'feature/merge',
    } as unknown as KanbanEpicRow;
    const doneCard = {
      ...makeCard({ epic_id: epic.id, column_id: 'col-done' }),
    };
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => epic) },
      getKanbanColumns: { all: vi.fn(() => [{ id: 'col-done', name: 'Done' }]) },
      getKanbanCardsByEpic: { all: vi.fn(() => [doneCard]) },
      getKanbanEpic: {
        get: vi.fn((id: string) =>
          id === epic.id ? ({ ...epic, autonomous: 0 } as KanbanEpicRow) : undefined,
        ),
      },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({
      board: { id: epic.board_id },
      columns: [],
      cards: [],
      epics: [epic],
    });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(stmts.updateKanbanEpic.run).toHaveBeenCalledTimes(1);
    const args = stmts.updateKanbanEpic.run.mock.calls[0] as unknown[];
    expect(args[3]).toBe(0);
    expect(args[8]).toBe('feature/merge');
    expect(args[9]).toBe(epic.id);
    expect(deps.broadcast).toHaveBeenCalledWith({ type: 'kanban_update', projectId: 'proj-1' });
    expect(stmts.getEligibleAutonomousCards.all).not.toHaveBeenCalled();
  });

  it('assigns an eligible card to an available sub agent and creates a session', async () => {
    const card = makeCard();
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => ACTIVE_EPIC) },
      getEligibleAutonomousCards: { all: vi.fn(() => [card]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [card]) },
    });
    stmts.getSession.get.mockImplementation((sessionId: string) => {
      const call = stmts.createSession.run.mock.calls.find((c) => c[0] === sessionId);
      if (!call) return undefined;
      return {
        id: sessionId,
        agent_id: call[1] as string,
        name: call[2] as string,
        engine: call[3] as string,
        model: call[4] as string,
        engine_session_id: null,
        use_worktree: 1,
        worktree_path: null,
        worktree_branch: null,
        git_worktree_detected: null,
        changes_ready: null,
        stale_pr_notified_at: null,
        ask_mode: 0,
        wiki_hybrid_rag_consumed: 0,
        cron_id: null,
        created_at: '2020-01-01T00:00:00.000Z',
        updated_at: '2020-01-01T00:00:00.000Z',
        deleted_at: null,
      } as SessionRow;
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(stmts.markCardDispatchedByAutonomous.run).toHaveBeenCalledWith('card-1');
    expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
    expect(stmts.moveKanbanCard.run).toHaveBeenCalledWith('col-progress', 0, 'card-1');
    expect(deps.handleChat).toHaveBeenCalledTimes(1);
    const callArgs = deps.handleChat.mock.calls[0][1] as { content: string };
    expect(callArgs.content).toContain('Build feature');
    const sessionCreated = deps.broadcast.mock.calls
      .map((c) => c[0] as { type?: string })
      .filter((p) => p.type === 'session_created');
    expect(sessionCreated).toHaveLength(1);
    expect(sessionCreated[0]).toMatchObject({ type: 'session_created', agentId: 'dev-1' });
  });

  it('uses epic autonomous_model when it is valid for the assignee engine', async () => {
    const card = makeCard();
    const epicWithModel = {
      ...ACTIVE_EPIC,
      autonomous_model: 'claude-sonnet-4-6',
    } as KanbanEpicRow;
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => epicWithModel) },
      getEligibleAutonomousCards: { all: vi.fn(() => [card]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [card]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    deps.getConfig.mockReturnValue({
      engineValidModels: { 'claude-code': ['claude-sonnet-4-6', 'claude-opus-4-7'] },
    } as never);
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(stmts.createSession.run).toHaveBeenCalledWith(
      expect.any(String),
      'dev-1',
      'Build feature',
      'claude-code',
      'claude-sonnet-4-6',
      1,
      0,
      1,
    );
  });

  it('ignores epic autonomous_model when it is not valid for the assignee engine', async () => {
    const card = makeCard();
    const epicWithModel = {
      ...ACTIVE_EPIC,
      autonomous_model: 'gpt-5.4',
    } as KanbanEpicRow;
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => epicWithModel) },
      getEligibleAutonomousCards: { all: vi.fn(() => [card]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [card]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    deps.getConfig.mockReturnValue({
      engineValidModels: { 'claude-code': ['claude-sonnet-4-6'] },
    } as never);
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(stmts.createSession.run).toHaveBeenCalledWith(
      expect.any(String),
      'dev-1',
      'Build feature',
      'claude-code',
      'mock-model',
      1,
      0,
      1,
    );
  });

  it('uses card assign_model when it is valid for the assignee engine (takes precedence over epic model)', async () => {
    const card = makeCard({ assign_model: 'claude-haiku-4-6' });
    const epicWithModel = {
      ...ACTIVE_EPIC,
      autonomous_model: 'claude-opus-4-7',
    } as KanbanEpicRow;
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => epicWithModel) },
      getEligibleAutonomousCards: { all: vi.fn(() => [card]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [card]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    deps.getConfig.mockReturnValue({
      engineValidModels: {
        'claude-code': ['claude-haiku-4-6', 'claude-opus-4-7', 'claude-sonnet-4-6'],
      },
    } as never);
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    // Card-level assign_model wins over epic-level autonomous_model
    expect(stmts.createSession.run).toHaveBeenCalledWith(
      expect.any(String),
      'dev-1',
      'Build feature',
      'claude-code',
      'claude-haiku-4-6',
      1,
      0,
      1,
    );
  });

  it('falls back to epic autonomous_model when card assign_model is not valid for the engine', async () => {
    const card = makeCard({ assign_model: 'gpt-99-ultra' });
    const epicWithModel = {
      ...ACTIVE_EPIC,
      autonomous_model: 'claude-sonnet-4-6',
    } as KanbanEpicRow;
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => epicWithModel) },
      getEligibleAutonomousCards: { all: vi.fn(() => [card]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [card]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    deps.getConfig.mockReturnValue({
      engineValidModels: { 'claude-code': ['claude-sonnet-4-6', 'claude-opus-4-7'] },
    } as never);
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    // Invalid card assign_model falls back to epic autonomous_model
    expect(stmts.createSession.run).toHaveBeenCalledWith(
      expect.any(String),
      'dev-1',
      'Build feature',
      'claude-code',
      'claude-sonnet-4-6',
      1,
      0,
      1,
    );
  });

  // ── Cross-engine model override (regression for "Autonomous model
  // selection not applied (Composer 2 ignored, runs as Claude Opus)") ─────
  it('spawns under the model-owning engine when epic autonomous_model is from a different engine', async () => {
    const card = makeCard();
    const epicWithModel = {
      ...ACTIVE_EPIC,
      autonomous_model: 'composer-2',
    } as KanbanEpicRow;
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => epicWithModel) },
      getEligibleAutonomousCards: { all: vi.fn(() => [card]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [card]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    deps.getConfig.mockReturnValue({
      engineValidModels: {
        'claude-code': ['claude-opus-4-7', 'claude-sonnet-4-6'],
        'cursor-agent': ['composer-2'],
      },
    } as never);
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    // Agent's default engine is claude-code, but the operator picked a
    // Cursor model. Honour the selection by spawning under cursor-agent
    // with composer-2 — rather than silently falling back to opus.
    expect(stmts.createSession.run).toHaveBeenCalledWith(
      expect.any(String),
      'dev-1',
      'Build feature',
      'cursor-agent',
      'composer-2',
      1,
      0,
      1,
    );
  });

  it('spawns under the model-owning engine when card assign_model is from a different engine', async () => {
    const card = makeCard({ assign_model: 'composer-2' });
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => ACTIVE_EPIC) },
      getEligibleAutonomousCards: { all: vi.fn(() => [card]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [card]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    deps.getConfig.mockReturnValue({
      engineValidModels: {
        'claude-code': ['claude-opus-4-7', 'claude-sonnet-4-6'],
        'cursor-agent': ['composer-2', 'composer-3'],
      },
    } as never);
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    // Card-level cross-engine override beats both the agent default and
    // any epic autonomous_model (which is null here).
    expect(stmts.createSession.run).toHaveBeenCalledWith(
      expect.any(String),
      'dev-1',
      'Build feature',
      'cursor-agent',
      'composer-2',
      1,
      0,
      1,
    );
  });

  it('still falls back to agent default when the model is in no configured engine allowlist', async () => {
    const card = makeCard();
    const epicWithModel = {
      ...ACTIVE_EPIC,
      autonomous_model: 'ghost-model-not-anywhere',
    } as KanbanEpicRow;
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => epicWithModel) },
      getEligibleAutonomousCards: { all: vi.fn(() => [card]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [card]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    deps.getConfig.mockReturnValue({
      engineValidModels: {
        'claude-code': ['claude-sonnet-4-6'],
        'cursor-agent': ['composer-2'],
      },
    } as never);
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    // Model isn't recognised by any engine — keep the agent's engine and
    // use the agent-default model (defaultModelForEngine returns 'mock-model'
    // per the top-of-file mock).
    expect(stmts.createSession.run).toHaveBeenCalledWith(
      expect.any(String),
      'dev-1',
      'Build feature',
      'claude-code',
      'mock-model',
      1,
      0,
      1,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  engineForModel — unit
// ═══════════════════════════════════════════════════════════════════════════

describe('engineForModel', () => {
  it('returns the engine when the model is in its allowlist', async () => {
    const { engineForModel } = await import('./autonomous.js');
    expect(
      engineForModel('composer-2', {
        'claude-code': ['claude-opus-4-7'],
        'cursor-agent': ['composer-2'],
      }),
    ).toBe('cursor-agent');
  });

  it('returns null when no engine owns the model', async () => {
    const { engineForModel } = await import('./autonomous.js');
    expect(
      engineForModel('ghost-model', {
        'claude-code': ['claude-opus-4-7'],
        'cursor-agent': ['composer-2'],
      }),
    ).toBeNull();
  });

  it('returns null on empty config', async () => {
    const { engineForModel } = await import('./autonomous.js');
    expect(engineForModel('any', {})).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  runAutonomousLoop — owner attribution (per-user identity)
// ═══════════════════════════════════════════════════════════════════════════

describe('runAutonomousLoop — owner attribution', () => {
  it('attributes the spawned session to the user returned by resolveAutonomousOwnerUserId', async () => {
    const card = makeCard({ created_by: 'userA' });
    const epicWithEnabler = {
      ...ACTIVE_EPIC,
      autonomous_enabled_by: 'enabler-user',
    } as KanbanEpicRow;
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => epicWithEnabler) },
      getEligibleAutonomousCards: { all: vi.fn(() => [card]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [card]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });

    const ownership = await import('./session-ownership.js');
    const mockResolveAutonomousOwner = ownership.resolveAutonomousOwnerUserId as Mock;
    const mockSetSessionOwner = ownership.setSessionOwner as Mock;
    mockResolveAutonomousOwner.mockReset();
    mockSetSessionOwner.mockReset();
    mockResolveAutonomousOwner.mockReturnValue('userA');

    initAutonomous(deps as never);
    await runAutonomousLoop('proj-1');

    // The dispatcher must consult the chain with BOTH the card and the
    // epic so created_by → session_id owner → autonomous_enabled_by →
    // org owner all have a chance to resolve.
    expect(mockResolveAutonomousOwner).toHaveBeenCalledTimes(1);
    const [calledCard, calledEpic] = mockResolveAutonomousOwner.mock.calls[0] as [unknown, unknown];
    expect((calledCard as { id: string }).id).toBe('card-1');
    expect((calledCard as { created_by: string }).created_by).toBe('userA');
    expect((calledEpic as { id: string }).id).toBe('epic-1');
    expect((calledEpic as { autonomous_enabled_by: string }).autonomous_enabled_by).toBe(
      'enabler-user',
    );

    // And the resolved id must be stamped onto the new session.
    expect(mockSetSessionOwner).toHaveBeenCalledTimes(1);
    const sessionId = stmts.createSession.run.mock.calls[0]?.[0] as string;
    expect(mockSetSessionOwner).toHaveBeenCalledWith(sessionId, 'userA');
  });

  it('still stamps null when the chain resolves to null (fresh install / pre-setup)', async () => {
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

    const ownership = await import('./session-ownership.js');
    const mockResolveAutonomousOwner = ownership.resolveAutonomousOwnerUserId as Mock;
    const mockSetSessionOwner = ownership.setSessionOwner as Mock;
    mockResolveAutonomousOwner.mockReset();
    mockSetSessionOwner.mockReset();
    mockResolveAutonomousOwner.mockReturnValue(null);

    initAutonomous(deps as never);
    await runAutonomousLoop('proj-1');

    expect(mockResolveAutonomousOwner).toHaveBeenCalledTimes(1);
    // setSessionOwner itself is a no-op on null (see session-ownership.ts),
    // but the dispatcher must still call it so the contract is observable.
    expect(mockSetSessionOwner).toHaveBeenCalledTimes(1);
    expect(mockSetSessionOwner.mock.calls[0]?.[1]).toBeNull();
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
    // Card carries label "dev-2" so the routing layer prefers the specialist
    // over the lead fallback. With subAgents=['dev-2'], dev-1 is filtered out
    // of the routing pool, so only dev-2 (or the lead fallback) can be picked.
    const card = makeCard({ labels: 'dev-2' });
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

  it('keeps the lead assignable as fallback even when subAgents is configured', async () => {
    // subAgents=['dev-2'] would historically have stripped lead-1 from the
    // assignable pool entirely. The card has no matching label, so the
    // routing layer must fall back to the lead — verifying the lead is
    // still in `assignableAgents`.
    const card = makeCard({ labels: '' });
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
    expect(sessionArgs[1]).toBe('lead-1');
    expect(stmts.createKanbanCardComment.run).not.toHaveBeenCalled();
  });

  it('falls back to role-filter when every subAgent id is stale/unresolved', async () => {
    // subAgents references agents that don't exist in the project (the
    // real-world Hub Lead Dev case). Old behavior: empty pool → "No
    // assignable agents". New behavior: drop back to the role-filter so
    // the lead + any specialists still pick up work.
    const card = makeCard({ labels: '' });
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
            subAgents: ['ghost-1', 'ghost-2'],
          },
          { id: 'dev-1', name: 'Dev One', role: 'sub', engine: 'claude-code' },
        ] as never,
      }),
    );
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    // No label match → routing falls to the lead. The new fallback put
    // lead-1 + dev-1 back in the pool (instead of bailing with the
    // "No assignable agents" notice), and the lead absorbs the card.
    expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
    const sessionArgs = stmts.createSession.run.mock.calls[0];
    expect(sessionArgs[1]).toBe('lead-1');
    expect(stmts.createKanbanCardComment.run).not.toHaveBeenCalled();
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

  it('coalesces concurrent invocations to a single dispatch (per-epic single-flight gate)', async () => {
    // Three eligible cards, max_concurrent=2 → exactly 2 should dispatch even
    // when `runAutonomousLoop` is fired three times in the same tick. Without
    // the per-epic single-flight gate, each invocation would observe an empty
    // active-card list and dispatch up to its own slot cap (=2), producing 6
    // `createSession.run` calls instead of 2 — the live "picks up 2 cards
    // before one is done" bug the gate fixes.
    const epic = {
      ...ACTIVE_EPIC,
      autonomous_max_concurrent: 2,
    } as unknown as KanbanEpicRow;
    const c1 = makeCard({ id: 'card-a', position: 0, title: 'A' });
    const c2 = makeCard({ id: 'card-b', position: 1, title: 'B' });
    const c3 = makeCard({ id: 'card-c', position: 2, title: 'C' });
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => epic) },
      getEligibleAutonomousCards: { all: vi.fn(() => [c1, c2, c3]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      // All three start in To Do — stateless mock means subsequent reads
      // (including the in-loop re-read inside the transactional claim) keep
      // returning the same array; without the gate, three invocations would
      // each see `activeNow=0` and burst through their caps in parallel.
      getKanbanCardsByEpic: { all: vi.fn(() => [c1, c2, c3]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await Promise.all([
      runAutonomousLoop('proj-1'),
      runAutonomousLoop('proj-1'),
      runAutonomousLoop('proj-1'),
    ]);

    // Exactly `slotsAvailable` (=2) cards dispatched in total — not 6.
    expect(stmts.createSession.run).toHaveBeenCalledTimes(2);
    expect(stmts.moveKanbanCard.run).toHaveBeenCalledTimes(2);
    expect(stmts.markCardDispatchedByAutonomous.run).toHaveBeenCalledTimes(2);
    expect(deps.handleChat).toHaveBeenCalledTimes(2);
    // Both moves target the In Progress column id from BOARD_COLS.
    for (const call of stmts.moveKanbanCard.run.mock.calls) {
      expect(call[0]).toBe('col-progress');
    }
  });

  it('aborts the transactional slot claim mid-loop when active count reaches the cap', async () => {
    // Two eligible cards, max_concurrent=2. After the first claim succeeds,
    // simulate another writer racing a card into In Progress: the second
    // call to `getKanbanCardsByEpic` returns two active rows. The in-loop
    // re-read inside `BEGIN IMMEDIATE` must abort the second claim instead
    // of moving a third card and breaching the cap.
    const epic = {
      ...ACTIVE_EPIC,
      autonomous_max_concurrent: 2,
    } as unknown as KanbanEpicRow;
    const c1 = makeCard({ id: 'card-a', position: 0, title: 'A' });
    const c2 = makeCard({ id: 'card-b', position: 1, title: 'B' });
    const racer = makeCard({ id: 'card-racer', column_id: 'col-progress', title: 'Raced in' });

    // getKanbanCardsByEpic.all is called three times inside runAutonomousLoopInner:
    //   call 0 — allEpicCardsForDone (done-check)
    //   call 1 — outer activeCardCount
    //   call 2 — in-transaction re-read (first while-loop iteration)
    //   call 3 — in-transaction re-read (second while-loop iteration)
    //
    // call 0: [c1, c2] — no done cards → epicWorkComplete=false, continue
    // call 1: [c1, c2] — 0 active → slotsAvailable=2, while-loop runs twice
    // call 2: [c1, c2, racer] — racer just raced in → activeNow=1<2, claim succeeds
    // call 3: [c1InProgress, c2, racer] — c1 now in-progress too → activeNow=2>=2, abort
    const c1InProgress = makeCard({
      id: 'card-a',
      position: 0,
      title: 'A',
      column_id: 'col-progress',
    });
    const epicCardsCalls = [
      [c1, c2], // call 0: done-check
      [c1, c2], // call 1: outer activeCardCount — 0 active, slotsAvailable=2
      [c1, c2, racer], // call 2: first in-tx re-read — activeNow=1<2, claim succeeds
      [c1InProgress, c2, racer], // call 3: second in-tx re-read — activeNow=2>=2, abort
    ];
    let callIdx = 0;
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => epic) },
      getEligibleAutonomousCards: { all: vi.fn(() => [c1, c2]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: {
        all: vi.fn(() => epicCardsCalls[Math.min(callIdx++, epicCardsCalls.length - 1)]),
      },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runAutonomousLoop('proj-1');

      // Outer check let both cards through (slotsAvailable=2). The transactional
      // re-read aborted the second claim, so only one card dispatched.
      expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
      expect(stmts.moveKanbanCard.run).toHaveBeenCalledTimes(1);
      expect(stmts.markCardDispatchedByAutonomous.run).toHaveBeenCalledTimes(1);
      // The abort log is the observable proof that the defense-in-depth branch ran.
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Autonomous] Slot claim aborted'),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  runAutonomousLoop — integration branch serialization
// ═══════════════════════════════════════════════════════════════════════════

describe('runAutonomousLoop — integration branch serialization', () => {
  it('forces serial dispatch (effective max=1) when epic has non-default pr_base_branch', async () => {
    // Three eligible cards, configured max_concurrent=3, but the epic targets
    // an operator-set integration branch — the override must collapse the
    // effective cap to 1 so cards land serially onto the umbrella.
    const epic = {
      ...ACTIVE_EPIC,
      autonomous_max_concurrent: 3,
      pr_base_branch: 'feature/integration',
    } as unknown as KanbanEpicRow;
    const c1 = makeCard({ id: 'card-a', position: 0, title: 'A' });
    const c2 = makeCard({ id: 'card-b', position: 1, title: 'B' });
    const c3 = makeCard({ id: 'card-c', position: 2, title: 'C' });
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => epic) },
      getEligibleAutonomousCards: { all: vi.fn(() => [c1, c2, c3]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      // No cards active yet — without the override, three cards would dispatch.
      getKanbanCardsByEpic: { all: vi.fn(() => [c1, c2, c3]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
    expect(stmts.moveKanbanCard.run).toHaveBeenCalledTimes(1);
    expect(deps.handleChat).toHaveBeenCalledTimes(1);
    // Stored configured cap should remain untouched (override is runtime-only).
    expect(epic.autonomous_max_concurrent).toBe(3);
  });

  it('respects configured max_concurrent=3 when pr_base_branch is null', async () => {
    // Identical setup minus the integration-branch flag — all three cards
    // dispatch as normal, proving the override doesn't leak to other epics.
    const epic = {
      ...ACTIVE_EPIC,
      autonomous_max_concurrent: 3,
      pr_base_branch: null,
    } as unknown as KanbanEpicRow;
    const c1 = makeCard({ id: 'card-a', position: 0, title: 'A' });
    const c2 = makeCard({ id: 'card-b', position: 1, title: 'B' });
    const c3 = makeCard({ id: 'card-c', position: 2, title: 'C' });
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => epic) },
      getEligibleAutonomousCards: { all: vi.fn(() => [c1, c2, c3]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [c1, c2, c3]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(stmts.createSession.run).toHaveBeenCalledTimes(3);
    expect(stmts.moveKanbanCard.run).toHaveBeenCalledTimes(3);
    expect(deps.handleChat).toHaveBeenCalledTimes(3);
  });

  it('treats empty/whitespace pr_base_branch as not-an-integration-branch', async () => {
    // Defense-in-depth: whitespace-only `pr_base_branch` should not trip the
    // override and collapse a configured cap of 3 down to 1.
    const epic = {
      ...ACTIVE_EPIC,
      autonomous_max_concurrent: 3,
      pr_base_branch: '   ',
    } as unknown as KanbanEpicRow;
    const c1 = makeCard({ id: 'card-a', position: 0, title: 'A' });
    const c2 = makeCard({ id: 'card-b', position: 1, title: 'B' });
    const c3 = makeCard({ id: 'card-c', position: 2, title: 'C' });
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => epic) },
      getEligibleAutonomousCards: { all: vi.fn(() => [c1, c2, c3]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [c1, c2, c3]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(stmts.createSession.run).toHaveBeenCalledTimes(3);
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

// ═══════════════════════════════════════════════════════════════════════════
//  Blocker-aware dispatch — cards with unresolved blockers are skipped
// ═══════════════════════════════════════════════════════════════════════════

describe('runAutonomousLoop — blocker filter', () => {
  // `loadBoardBlockers` hits `getBlockersForBoard` directly, so the mock just
  // needs to return rows in the same shape the prepared statement does.
  function blockerRow(opts: {
    card: string;
    blockedBy: string;
    blockerColumn: string;
    blockedColumn: string;
  }): Record<string, string> {
    return {
      card_id: opts.card,
      blocked_by_card_id: opts.blockedBy,
      blocker_id: opts.blockedBy,
      blocker_title: `title-${opts.blockedBy}`,
      blocker_column_id: `col-${opts.blockerColumn}`,
      blocker_column_name: opts.blockerColumn,
      blocked_id: opts.card,
      blocked_title: `title-${opts.card}`,
      blocked_column_id: `col-${opts.blockedColumn}`,
      blocked_column_name: opts.blockedColumn,
    };
  }

  it('skips a card whose blocker is still in a non-Done column', async () => {
    const blocked = makeCard({ id: 'blocked-card', title: 'Needs upstream' });
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => ACTIVE_EPIC) },
      getEligibleAutonomousCards: { all: vi.fn(() => [blocked]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [blocked]) },
      getBlockersForBoard: {
        all: vi.fn(() => [
          blockerRow({
            card: 'blocked-card',
            blockedBy: 'upstream-card',
            blockerColumn: 'In Progress',
            blockedColumn: 'To Do',
          }),
        ]),
      },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    // No session created, no chat dispatched, no iteration increment.
    expect(stmts.createSession.run).not.toHaveBeenCalled();
    expect(deps.handleChat).not.toHaveBeenCalled();
    expect(stmts.markCardDispatchedByAutonomous.run).not.toHaveBeenCalled();
  });

  it('dispatches a card whose blocker is in a Done column', async () => {
    const ready = makeCard({ id: 'ready-card', title: 'Unblocked now' });
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => ACTIVE_EPIC) },
      getEligibleAutonomousCards: { all: vi.fn(() => [ready]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [ready]) },
      getBlockersForBoard: {
        all: vi.fn(() => [
          blockerRow({
            card: 'ready-card',
            blockedBy: 'finished-card',
            blockerColumn: 'Done',
            blockedColumn: 'To Do',
          }),
        ]),
      },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(stmts.markCardDispatchedByAutonomous.run).toHaveBeenCalledWith('ready-card');
    expect(deps.handleChat).toHaveBeenCalled();
  });

  it('prefers unblocked cards when eligible list contains both', async () => {
    const blocked = makeCard({ id: 'b-card', title: 'Blocked' });
    const ready = makeCard({ id: 'r-card', title: 'Ready', position: 1 });
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => ACTIVE_EPIC) },
      // Blocked listed first — the filter must remove it before assignment.
      getEligibleAutonomousCards: { all: vi.fn(() => [blocked, ready]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [blocked, ready]) },
      getBlockersForBoard: {
        all: vi.fn(() => [
          blockerRow({
            card: 'b-card',
            blockedBy: 'upstream',
            blockerColumn: 'In Progress',
            blockedColumn: 'To Do',
          }),
        ]),
      },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    // Only the ready card gets its iteration counter bumped.
    expect(stmts.markCardDispatchedByAutonomous.run).toHaveBeenCalledTimes(1);
    expect(stmts.markCardDispatchedByAutonomous.run).toHaveBeenCalledWith('r-card');
  });

  // ─── Visible-signal contract ────────────────────────────────────────────
  //
  // Before this fix the only signal that the dispatcher had skipped a card
  // for blocker reasons was a `console.log` line — invisible to anyone
  // watching the UI. The contract is now: on the FIRST tick where a card
  // is skipped for a particular blocker set, post one `system` comment on
  // the card naming the unresolved blockers, then debounce until the
  // signature changes.

  it('posts a system comment on the skipped card naming the unresolved blockers', async () => {
    const blocked = makeCard({ id: 'blocked-card', title: 'Needs upstream' });
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => ACTIVE_EPIC) },
      getEligibleAutonomousCards: { all: vi.fn(() => [blocked]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [blocked]) },
      getBlockersForBoard: {
        all: vi.fn(() => [
          blockerRow({
            card: 'blocked-card',
            blockedBy: 'upstream-card',
            blockerColumn: 'In Progress',
            blockedColumn: 'To Do',
          }),
        ]),
      },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    // One system comment on the blocked card.
    expect(stmts.createKanbanCardComment.run).toHaveBeenCalledTimes(1);
    const args = stmts.createKanbanCardComment.run.mock.calls[0] as unknown[];
    // args: [id, cardId, author, content]
    expect(args[1]).toBe('blocked-card');
    expect(args[2]).toBe('system');
    const content = args[3] as string;
    expect(content).toContain('Autonomous dispatch skipped');
    expect(content).toContain('title-upstream-card'); // blocker title
    expect(content).toContain('upstream-card'); // blocker id
    // UI gets notified so the comment renders without a manual refresh.
    expect(deps.broadcast).toHaveBeenCalledWith({ type: 'kanban_update', projectId: 'proj-1' });
  });

  it('debounces — does not re-comment on subsequent ticks with the same blocker set', async () => {
    const blocked = makeCard({ id: 'blocked-card', title: 'Needs upstream' });
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => ACTIVE_EPIC) },
      getEligibleAutonomousCards: { all: vi.fn(() => [blocked]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [blocked]) },
      getBlockersForBoard: {
        all: vi.fn(() => [
          blockerRow({
            card: 'blocked-card',
            blockedBy: 'upstream-card',
            blockerColumn: 'In Progress',
            blockedColumn: 'To Do',
          }),
        ]),
      },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');
    await runAutonomousLoop('proj-1');
    await runAutonomousLoop('proj-1');

    // Three ticks, one comment — debounced by signature.
    expect(stmts.createKanbanCardComment.run).toHaveBeenCalledTimes(1);
  });

  it('re-emits the comment when the blocker set changes (different blocker)', async () => {
    const blocked = makeCard({ id: 'blocked-card', title: 'Needs upstream' });
    const firstBlocker = [
      blockerRow({
        card: 'blocked-card',
        blockedBy: 'first-upstream',
        blockerColumn: 'In Progress',
        blockedColumn: 'To Do',
      }),
    ];
    const secondBlocker = [
      blockerRow({
        card: 'blocked-card',
        blockedBy: 'second-upstream',
        blockerColumn: 'In Progress',
        blockedColumn: 'To Do',
      }),
    ];
    const getBlockersForBoard = vi
      .fn()
      .mockReturnValueOnce(firstBlocker)
      .mockReturnValueOnce(secondBlocker);
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => ACTIVE_EPIC) },
      getEligibleAutonomousCards: { all: vi.fn(() => [blocked]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [blocked]) },
      getBlockersForBoard: { all: getBlockersForBoard },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');
    await runAutonomousLoop('proj-1');

    // Signature changed (different blocker id) → second comment posted.
    expect(stmts.createKanbanCardComment.run).toHaveBeenCalledTimes(2);
  });

  it('clears the debounce key when the card becomes eligible again', async () => {
    const card = makeCard({ id: 'flappy-card', title: 'Sometimes blocked' });
    const blockedRows = [
      blockerRow({
        card: 'flappy-card',
        blockedBy: 'upstream',
        blockerColumn: 'In Progress',
        blockedColumn: 'To Do',
      }),
    ];
    const clearedRows = [
      blockerRow({
        card: 'flappy-card',
        blockedBy: 'upstream',
        blockerColumn: 'Done',
        blockedColumn: 'To Do',
      }),
    ];
    const blockedAgainRows = [
      blockerRow({
        card: 'flappy-card',
        blockedBy: 'upstream',
        blockerColumn: 'In Progress',
        blockedColumn: 'To Do',
      }),
    ];
    const getBlockersForBoard = vi
      .fn()
      .mockReturnValueOnce(blockedRows)
      .mockReturnValueOnce(clearedRows)
      .mockReturnValueOnce(blockedAgainRows);
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => ACTIVE_EPIC) },
      getEligibleAutonomousCards: { all: vi.fn(() => [card]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [card]) },
      getBlockersForBoard: { all: getBlockersForBoard },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    // Tick 1: blocked → comment.
    await runAutonomousLoop('proj-1');
    expect(stmts.createKanbanCardComment.run).toHaveBeenCalledTimes(1);
    expect(lastBlockerSkipSignature.has('flappy-card')).toBe(true);

    // Tick 2: blocker now Done → card eligible, debounce key cleared.
    await runAutonomousLoop('proj-1');
    expect(lastBlockerSkipSignature.has('flappy-card')).toBe(false);

    // Tick 3: blocker regressed → fresh comment (not silenced by stale signature).
    await runAutonomousLoop('proj-1');
    expect(stmts.createKanbanCardComment.run).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  isPrMergeDirty — poll-side conflict detection
//  Exercises the pure helper used by `reconcileKanbanWithGitHub` when the
//  3-minute poller examines an open PR. GitHub does NOT fire a webhook when
//  PR A merges and dirties PR B (base changed, not head), so the poller is
//  the only path that surfaces this failure mode.
// ═══════════════════════════════════════════════════════════════════════════

describe('isPrMergeDirty', () => {
  it('flags mergeable === false as dirty (GitHub computed, conflict present)', () => {
    expect(isPrMergeDirty({ mergeable: false, mergeable_state: 'dirty' })).toBe(true);
  });

  it('flags mergeable_state "dirty" as dirty regardless of mergeable shape', () => {
    expect(isPrMergeDirty({ mergeable: null, mergeable_state: 'dirty' })).toBe(true);
    expect(isPrMergeDirty({ mergeable: true, mergeable_state: 'dirty' })).toBe(true);
  });

  it('flags mergeable_state "behind" as dirty (base required strict checks)', () => {
    expect(isPrMergeDirty({ mergeable: true, mergeable_state: 'behind' })).toBe(true);
  });

  it('is case-insensitive on mergeable_state (REST returns lowercase; be defensive)', () => {
    expect(isPrMergeDirty({ mergeable: null, mergeable_state: 'DIRTY' })).toBe(true);
    expect(isPrMergeDirty({ mergeable: null, mergeable_state: 'Behind' })).toBe(true);
  });

  it('does NOT flag a clean PR', () => {
    expect(isPrMergeDirty({ mergeable: true, mergeable_state: 'clean' })).toBe(false);
  });

  it('does NOT flag while GitHub is still computing (mergeable=null, no known state)', () => {
    // Initial webhook payloads and freshly-opened PRs often have null here.
    // We deliberately defer to the next poll cycle rather than false-positive.
    expect(isPrMergeDirty({ mergeable: null, mergeable_state: null })).toBe(false);
    expect(isPrMergeDirty({ mergeable: null, mergeable_state: 'unknown' })).toBe(false);
  });

  it('does NOT flag other non-dirty states (blocked, unstable, has_hooks)', () => {
    // `blocked` means required reviews/checks missing — that's a review/CI
    // concern, not a merge-conflict escalation. Same for unstable.
    expect(isPrMergeDirty({ mergeable: true, mergeable_state: 'blocked' })).toBe(false);
    expect(isPrMergeDirty({ mergeable: true, mergeable_state: 'unstable' })).toBe(false);
    expect(isPrMergeDirty({ mergeable: true, mergeable_state: 'has_hooks' })).toBe(false);
  });

  it('tolerates missing fields without throwing', () => {
    expect(isPrMergeDirty({})).toBe(false);
    expect(isPrMergeDirty({ mergeable: undefined, mergeable_state: undefined })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  runAutonomousLoop — label-based routing
//
//  Triage is gone. Cards now dispatch to the first specialist whose
//  id/role/name/id-tail matches a label on the card. When no label matches,
//  the project lead picks the card up (and can `<handoff>` if it would
//  rather route the work).
// ═══════════════════════════════════════════════════════════════════════════

describe('runAutonomousLoop — label routing', () => {
  it('routes a card to the specialist whose id-tail matches a label', async () => {
    const card = makeCard({ labels: 'frontend' });
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
          { id: 'hub-frontend', name: 'Frontend', role: 'sub', engine: 'claude-code' },
          { id: 'hub-backend', name: 'Backend', role: 'sub', engine: 'claude-code' },
        ],
      }),
    );
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
    expect(stmts.createSession.run.mock.calls[0][1]).toBe('hub-frontend');
  });

  it('falls back to the project lead when no label matches', async () => {
    const card = makeCard({ labels: 'mobile' });
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
          { id: 'hub-lead', name: 'Lead', role: 'lead', engine: 'claude-code' },
          { id: 'hub-frontend', name: 'Frontend', role: 'sub', engine: 'claude-code' },
          { id: 'hub-backend', name: 'Backend', role: 'sub', engine: 'claude-code' },
        ],
      }),
    );
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
    expect(stmts.createSession.run.mock.calls[0][1]).toBe('hub-lead');
  });

  it('falls back to the lead when the matching specialist is out of slots', async () => {
    // Per-agent cap now equals epic.autonomous_max_concurrent (= 3). When
    // hub-frontend already has 3 active sessions it has zero remaining slots
    // for this tick, so the frontend label can't be honored → spillover to
    // the project lead. (Previously this test exercised the old implicit
    // `ceil(max_concurrent / agentCount)` partition, which is gone.)
    const card = makeCard({ labels: 'frontend' });
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => ACTIVE_EPIC) },
      getEligibleAutonomousCards: { all: vi.fn(() => [card]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [card]) },
    });
    stmts.getSession.get.mockImplementation((sid: string) => {
      if (sid === 'busy-1' || sid === 'busy-2' || sid === 'busy-3') {
        return { agent_id: 'hub-frontend' } as SessionRow;
      }
      return undefined;
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(
      makeProject({
        agents: [
          { id: 'hub-lead', name: 'Lead', role: 'lead', engine: 'claude-code' },
          { id: 'hub-frontend', name: 'Frontend', role: 'sub', engine: 'claude-code' },
          { id: 'hub-backend', name: 'Backend', role: 'sub', engine: 'claude-code' },
        ],
      }),
    );
    deps.getActiveProcesses.mockReturnValue(
      new Map<string, unknown>([
        ['busy-1', {}],
        ['busy-2', {}],
        ['busy-3', {}],
      ]),
    );
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
    expect(stmts.createSession.run.mock.calls[0][1]).toBe('hub-lead');
  });

  it('lets a single specialist absorb multiple cards in one tick (agentCount > max_concurrent)', async () => {
    // Regression: previously `perAgentLimit = ceil(max_concurrent / agentCount)`
    // would compute `ceil(3/4) = 1` here, so hub-frontend could only take
    // one of the three eligible frontend cards in a tick — the remaining
    // two would fall through to the lead. With the per-agent cap now equal
    // to the epic-wide cap, hub-frontend can absorb all three.
    const c1 = makeCard({ id: 'c1', title: 'FE 1', labels: 'frontend' });
    const c2 = makeCard({ id: 'c2', title: 'FE 2', labels: 'frontend', position: 1 });
    const c3 = makeCard({ id: 'c3', title: 'FE 3', labels: 'frontend', position: 2 });
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => ACTIVE_EPIC) }, // max_concurrent = 3
      getEligibleAutonomousCards: { all: vi.fn(() => [c1, c2, c3]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [c1, c2, c3]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(
      makeProject({
        agents: [
          { id: 'hub-lead', name: 'Lead', role: 'lead', engine: 'claude-code' },
          { id: 'hub-frontend', name: 'Frontend', role: 'sub', engine: 'claude-code' },
          { id: 'hub-backend', name: 'Backend', role: 'sub', engine: 'claude-code' },
          { id: 'hub-mobile', name: 'Mobile', role: 'sub', engine: 'claude-code' },
        ],
      }),
    );
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(stmts.createSession.run).toHaveBeenCalledTimes(3);
    expect(stmts.createSession.run.mock.calls[0][1]).toBe('hub-frontend');
    expect(stmts.createSession.run.mock.calls[1][1]).toBe('hub-frontend');
    expect(stmts.createSession.run.mock.calls[2][1]).toBe('hub-frontend');
  });

  it('routes multiple cards to the same specialist when labels match', async () => {
    const c1 = makeCard({ id: 'c1', title: 'FE one', labels: 'frontend' });
    const c2 = makeCard({ id: 'c2', title: 'FE two', labels: 'frontend', position: 1 });
    const epicHigh = { ...ACTIVE_EPIC, autonomous_max_concurrent: 4 } as KanbanEpicRow;
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => epicHigh) },
      getEligibleAutonomousCards: { all: vi.fn(() => [c1, c2]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [c1, c2]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(
      makeProject({
        agents: [
          { id: 'hub-frontend', name: 'Frontend', role: 'sub', engine: 'claude-code' },
          { id: 'hub-backend', name: 'Backend', role: 'sub', engine: 'claude-code' },
        ],
      }),
    );
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    expect(stmts.createSession.run).toHaveBeenCalledTimes(2);
    expect(stmts.createSession.run.mock.calls[0][1]).toBe('hub-frontend');
    expect(stmts.createSession.run.mock.calls[1][1]).toBe('hub-frontend');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  runAutonomousLoop — DEV_HUB_API_KEY label gate
//
//  Positive: cards labelled `cross-hub:dev` or `survey-tracker` must cause
//    handleChat to be called with `extraEnv: { DEV_HUB_API_KEY: '...' }`.
//  Negative: cards without those labels must NOT inject DEV_HUB_API_KEY.
// ═══════════════════════════════════════════════════════════════════════════

describe('runAutonomousLoop — DEV_HUB_API_KEY label gate', () => {
  function makeMinimalSetup(card: KanbanCardRow) {
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => ACTIVE_EPIC) },
      getEligibleAutonomousCards: { all: vi.fn(() => [card]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [card]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(
      makeProject({
        agents: [{ id: 'dev-1', name: 'Dev One', role: 'sub', engine: 'claude-code' }],
      }),
    );
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);
    return deps;
  }

  beforeEach(() => {
    mockGetDevHubApiKeyFn.mockResolvedValue('ahub_mock_dev_key');
  });

  it('POSITIVE: cross-hub:dev label → handleChat called with DEV_HUB_API_KEY', async () => {
    const card = makeCard({ id: 'c-xhub', labels: 'cross-hub:dev,infra' });
    const deps = makeMinimalSetup(card);

    await runAutonomousLoop('proj-1');

    expect(deps.handleChat).toHaveBeenCalledTimes(1);
    const chatMsg = deps.handleChat.mock.calls[0][1];
    expect(chatMsg.extraEnv).toBeDefined();
    expect(chatMsg.extraEnv.DEV_HUB_API_KEY).toBe('ahub_mock_dev_key');
  });

  it('POSITIVE: survey-tracker label → handleChat called with DEV_HUB_API_KEY', async () => {
    const card = makeCard({ id: 'c-st', labels: 'survey-tracker,backend' });
    const deps = makeMinimalSetup(card);

    await runAutonomousLoop('proj-1');

    expect(deps.handleChat).toHaveBeenCalledTimes(1);
    const chatMsg = deps.handleChat.mock.calls[0][1];
    expect(chatMsg.extraEnv).toBeDefined();
    expect(chatMsg.extraEnv.DEV_HUB_API_KEY).toBe('ahub_mock_dev_key');
  });

  it('NEGATIVE: card without cross-hub label → handleChat called WITHOUT DEV_HUB_API_KEY', async () => {
    const card = makeCard({ id: 'c-plain', labels: 'infra,backend' });
    const deps = makeMinimalSetup(card);

    await runAutonomousLoop('proj-1');

    expect(deps.handleChat).toHaveBeenCalledTimes(1);
    const chatMsg = deps.handleChat.mock.calls[0][1];
    // extraEnv must be absent or empty — DEV_HUB_API_KEY must NOT appear.
    expect(chatMsg.extraEnv?.DEV_HUB_API_KEY).toBeUndefined();
  });

  it('NEGATIVE: card with null labels → handleChat called WITHOUT DEV_HUB_API_KEY', async () => {
    const card = makeCard({ id: 'c-null', labels: null as unknown as string });
    const deps = makeMinimalSetup(card);

    await runAutonomousLoop('proj-1');

    expect(deps.handleChat).toHaveBeenCalledTimes(1);
    const chatMsg = deps.handleChat.mock.calls[0][1];
    expect(chatMsg.extraEnv?.DEV_HUB_API_KEY).toBeUndefined();
  });

  it('NEGATIVE: getDevHubApiKey returns null → handleChat called WITHOUT DEV_HUB_API_KEY', async () => {
    // Simulate Secrets Manager being unreachable.
    mockGetDevHubApiKeyFn.mockResolvedValue(null);
    const card = makeCard({ id: 'c-fail', labels: 'cross-hub:dev' });
    const deps = makeMinimalSetup(card);

    await runAutonomousLoop('proj-1');

    expect(deps.handleChat).toHaveBeenCalledTimes(1);
    const chatMsg = deps.handleChat.mock.calls[0][1];
    expect(chatMsg.extraEnv?.DEV_HUB_API_KEY).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  runAutonomousLoop — _fromAutonomousDispatch sentinel
//
//  Card 395e044c-… (Identity leak: block direct `gh api /reviews` calls):
//  every autonomous-dispatch chat message must carry
//  `_fromAutonomousDispatch: true` so `chat.ts` can route through the
//  token-stripping branch of `selectGithubSpawnToken`. Without the
//  sentinel, the org-owner OAuth token leaks into the spawn env and the
//  agent can post formal PR reviews via `gh api repos/.../reviews -X POST`
//  under the human's identity.
// ═══════════════════════════════════════════════════════════════════════════

describe('runAutonomousLoop — _fromAutonomousDispatch sentinel', () => {
  function makeMinimalSetup(card: KanbanCardRow) {
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => ACTIVE_EPIC) },
      getEligibleAutonomousCards: { all: vi.fn(() => [card]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [card]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(
      makeProject({
        agents: [{ id: 'dev-1', name: 'Dev One', role: 'sub', engine: 'claude-code' }],
      }),
    );
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    initAutonomous(deps as never);
    return deps;
  }

  it('handleChat called with _fromAutonomousDispatch=true', async () => {
    const card = makeCard({ id: 'c-1', labels: 'infra' });
    const deps = makeMinimalSetup(card);

    await runAutonomousLoop('proj-1');

    expect(deps.handleChat).toHaveBeenCalledTimes(1);
    const chatMsg = deps.handleChat.mock.calls[0][1];
    expect(chatMsg._fromAutonomousDispatch).toBe(true);
  });

  it('sentinel is present even when no opt-in label triggers DEV_HUB_API_KEY (the two paths are orthogonal)', async () => {
    // Regression guard: the dev-hub label gate uses the `extraEnv`
    // spread; the autonomous sentinel must NOT live inside `extraEnv`
    // (the allowlist filter in `extra-env-allowlist.ts` would drop it).
    // It belongs at the top level of the ChatMessage so chat.ts can
    // read `msg._fromAutonomousDispatch` directly.
    const card = makeCard({ id: 'c-plain', labels: 'infra,backend' });
    const deps = makeMinimalSetup(card);

    await runAutonomousLoop('proj-1');

    expect(deps.handleChat).toHaveBeenCalledTimes(1);
    const chatMsg = deps.handleChat.mock.calls[0][1];
    expect(chatMsg._fromAutonomousDispatch).toBe(true);
    expect(chatMsg.extraEnv).toBeUndefined();
  });

  it('sentinel coexists with extraEnv for opt-in cross-hub:dev cards', async () => {
    mockGetDevHubApiKeyFn.mockResolvedValue('ahub_mock_dev_key');
    const card = makeCard({ id: 'c-xhub', labels: 'cross-hub:dev,infra' });
    const deps = makeMinimalSetup(card);

    await runAutonomousLoop('proj-1');

    expect(deps.handleChat).toHaveBeenCalledTimes(1);
    const chatMsg = deps.handleChat.mock.calls[0][1];
    expect(chatMsg._fromAutonomousDispatch).toBe(true);
    expect(chatMsg.extraEnv?.DEV_HUB_API_KEY).toBe('ahub_mock_dev_key');
  });
});
