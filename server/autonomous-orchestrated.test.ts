import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { Project, KanbanCardRow, KanbanEpicRow, KanbanPhaseRow } from './types.js';
import type { EpicManagerPort, ReadyCardOffer } from './autonomous.js';

// Module mocks (hoisted before imports)

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn(() => ({ stop: vi.fn() })),
  },
  schedule: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock('./routes/board.js', () => ({
  getOrCreateBoard: vi.fn(),
}));

vi.mock('./config.js', () => ({
  // Auth dependencies initialize SQLite at import time. Use the existing per-file
  // directory from test/setup.ts, never a shared or nonexistent fixed path.
  default: { apiKey: null, dataDir: process.env.AGENT_HUB_DATA_DIR! },
  defaultModelForEngine: vi.fn(() => 'mock-model'),
}));

vi.mock('./session-ship.js', () => ({
  markSessionAutoShipOnComplete: vi.fn(),
  markSessionFinalizeAutomation: vi.fn(),
}));

const userPrefs = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('./user-preferences-store.js', () => ({
  getUserPreferencesRow: vi.fn(() => userPrefs.current),
}));

vi.mock('./session-ownership.js', () => ({
  setSessionOwner: vi.fn(),
  getOrgOwnerUserId: vi.fn(() => null),
  inheritOwnerFromSession: vi.fn(),
  resolveOwnerUserId: vi.fn(() => null),
  resolveAutonomousOwnerUserId: vi.fn(() => 'test-operator'),
  userOwnsSession: vi.fn(() => true),
}));

// Secrets mock (controls cross-hub label gate)
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
  spawnEpicWorkerForCard,
  runAutonomousLoop,
  runAutonomousLoopForPhase,
  startAutonomousPhase,
  scheduleAutonomousEpic,
  scheduleAutonomousPhase,
  resetEpicManagerPresenceForTest,
  noteOrchestratedEpicsChanged,
  autonomousProjects,
  autonomousCrons,
  autonomousEpicsByProject,
  lastDispatchedReviewId,
  lastBlockerSkipSignature,
} = await import('./autonomous.js');

const { getOrCreateBoard } = await import('./routes/board.js');
const mockGetOrCreateBoard = getOrCreateBoard as Mock;

const { markSessionFinalizeAutomation: mockMarkFinalizeAutomation } =
  await import('./session-ship.js');
const mockMarkFinalizeAutomationFn = mockMarkFinalizeAutomation as Mock;

// Rows the instant-forward manager below has seen. The default card/epic
// lookups read these, so the worker spawn (which re-reads the card and epic by
// id) sees the same rows the loop offered.
const cardRegistry = new Map<string, KanbanCardRow>();
const epicRegistry = new Map<string, KanbanEpicRow>();

/**
 * Stand-in for the epic manager thread that forwards every ready card at once,
 * the way a manager's forward cards do after Auto start. Lets these tests
 * drive the loop and the worker spawn end to end.
 */
function instantForwardManager(): EpicManagerPort & { offered: ReadyCardOffer[][] } {
  const offered: ReadyCardOffer[][] = [];
  return {
    offered,
    async offerReady({ projectId, epic, ready, ownerUserId }) {
      offered.push(ready);
      epicRegistry.set(epic.id, epic);
      for (const offer of ready) {
        if (!cardRegistry.has(offer.card.id)) cardRegistry.set(offer.card.id, offer.card);
        const result = spawnEpicWorkerForCard({
          projectId,
          cardId: offer.card.id,
          agentId: offer.agentId,
          ownerUserId,
        });
        if (result.status === 'started') await result.turn;
        else if (result.code === 'cap') break;
      }
    },
    hasLiveManager: () => true,
    liveOffers: () => [],
    withdrawOffer: () => {},
    isOffered: () => false,
    isHeld: () => false,
    isAtRetryCap: () => false,
    noteWorkerStarted: () => {},
    handOver: () => false,
    noteWorkerEvent: () => {},
    observeCards: () => {},
    kickoff: () => null,
    pause: () => {},
    noteRetryCapRefusal: () => {},
  };
}

interface MockStmts {
  getSupportTicket?: { get: Mock };
  listSupportTicketComments?: { all: Mock };
  getAutonomousEpic: { get: Mock };
  // Optional plural statement. When present, the loop dispatches EVERY returned
  // epic (multi-epic boards). When absent, `listAutonomousEpics` falls back to
  // the singular `getAutonomousEpic`, preserving legacy single-epic behavior —
  // which is why the default `makeStmts` intentionally omits it.
  getAutonomousEpics?: { all: Mock };
  getAutonomousPhases?: { all: Mock };
  getEligibleAutonomousCards: { all: Mock };
  getEligibleAutonomousCardsByPhase?: { all: Mock };
  getEligibleAutonomousSpikeCards?: { all: Mock };
  getEligibleAutonomousSpikeCardsByPhase?: { all: Mock };
  countOpenKanbanSpecItemsByEpic?: { get: Mock };
  countOpenKanbanSpecItemsByPhase?: { get: Mock };
  getKanbanSpecItemsByEpic?: { all: Mock };
  getKanbanSpecItemBySpikeCard?: { get: Mock };
  updateSessionMode?: { run: Mock };
  updateSessionLinkedEpic?: { run: Mock };
  updateSessionLinkedSpecItem?: { run: Mock };
  updateSessionSpikeCard?: { run: Mock };
  getKanbanColumns: { all: Mock };
  getKanbanColumn?: { get: Mock };
  getSession: { get: Mock };
  getKanbanCard: { get: Mock };
  getKanbanCardsByEpic: { all: Mock };
  getKanbanCardsByPhase?: { all: Mock };
  getKanbanPhase?: { get: Mock };
  getKanbanPhasesByEpic?: { all: Mock };
  updateKanbanPhase?: { run: Mock };
  setPhaseAutonomousRunning?: { run: Mock };
  setPhaseAutonomousEnabledBy?: { run: Mock };
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
  // Per-agent slot accounting: dispatcher only counts autonomous-dispatched
  // sessions toward the slot cap, identified by the linked kanban card's
  // `dispatched_by_autonomous` flag. Default returns undefined (no linked
  // card → not counted), matching the common test case where active sessions
  // are interactive chat.
  getKanbanCardBySession: { get: Mock };
  // Board → project, so the epic resolves the project's orchestratedEpics setting.
  getKanbanBoardById: { get: Mock };
}

function makeStmts(overrides: Partial<MockStmts> = {}): MockStmts {
  return {
    getAutonomousEpic: { get: vi.fn(() => null) },
    getAutonomousPhases: { all: vi.fn(() => []) },
    getKanbanPhasesByEpic: { all: vi.fn(() => []) },
    getEligibleAutonomousCards: { all: vi.fn(() => []) },
    getEligibleAutonomousSpikeCards: { all: vi.fn(() => []) },
    getEligibleAutonomousSpikeCardsByPhase: { all: vi.fn(() => []) },
    getEligibleAutonomousCardsByPhase: { all: vi.fn(() => []) },
    countOpenKanbanSpecItemsByEpic: { get: vi.fn(() => ({ n: 0 })) },
    countOpenKanbanSpecItemsByPhase: { get: vi.fn(() => ({ n: 0 })) },
    getKanbanSpecItemsByEpic: { all: vi.fn(() => []) },
    getKanbanSpecItemBySpikeCard: { get: vi.fn(() => undefined) },
    updateSessionMode: { run: vi.fn() },
    updateSessionLinkedEpic: { run: vi.fn() },
    updateSessionLinkedSpecItem: { run: vi.fn() },
    updateSessionSpikeCard: { run: vi.fn() },
    getKanbanColumns: { all: vi.fn(() => []) },
    getSession: { get: vi.fn(() => null) },
    // Default: the card re-read inside the transactional slot claim is still
    // eligible (To Do, not dispatched, no session). Tests that simulate a
    // concurrent claim override this to return an already-claimed row.
    getKanbanCard: { get: vi.fn((id: string) => cardRegistry.get(id) ?? makeCard({ id })) },
    getKanbanCardsByEpic: { all: vi.fn(() => []) },
    getKanbanEpic: { get: vi.fn((id: string) => epicRegistry.get(id)) },
    updateKanbanEpic: { run: vi.fn() },
    createSession: { run: vi.fn() },
    updateKanbanCard: { run: vi.fn() },
    moveKanbanCard: { run: vi.fn() },
    markCardDispatchedByAutonomous: { run: vi.fn() },
    createKanbanCardComment: { run: vi.fn() },
    getBlockersForBoard: { all: vi.fn(() => []) },
    getBlockersForCard: { all: vi.fn(() => []) },
    getKanbanCardBySession: { get: vi.fn(() => undefined) },
    getKanbanBoardById: { get: vi.fn(() => ({ id: 'board-1', project_id: 'proj-1' })) },
    ...overrides,
  };
}

interface MockDeps {
  stmts: MockStmts;
  broadcast: Mock;
  findProject: Mock;
  findAgent: Mock;
  handleChat: Mock;
  prepareSessionEnv?: Mock;
  handleCancel: Mock;
  getActiveProcesses: Mock;
  getProjects: Mock;
  getConfig: Mock;
  getGhAuthenticatedUser: Mock;
  getDb: Mock;
  epicManager: EpicManagerPort & { offered: ReadyCardOffer[][] };
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
    getDb: vi.fn(() => makeFakeDb()),
    epicManager: instantForwardManager(),
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    cwd: '/tmp',
    ahw: '',
    // Every test in this file runs the epic manager path.
    orchestratedEpics: true,
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
  { id: 'col-canceled', name: 'Canceled' },
];

const ACTIVE_EPIC: KanbanEpicRow = {
  id: 'epic-1',
  board_id: 'board-1',
  name: 'Sprint 1',
  autonomous: 1,
  autonomous_max_concurrent: 3,
  autonomous_model: null,
} as unknown as KanbanEpicRow;

beforeEach(async () => {
  cardRegistry.clear();
  epicRegistry.clear();
  mockGetOrCreateBoard.mockReset();
  mockMarkFinalizeAutomationFn.mockClear();
  autonomousProjects.clear();
  autonomousEpicsByProject.clear();
  for (const t of autonomousCrons.values()) t.stop?.();
  autonomousCrons.clear();
  lastDispatchedReviewId.clear();
  lastBlockerSkipSignature.clear();
  const ownership = await import('./session-ownership.js');
  (ownership.resolveAutonomousOwnerUserId as Mock).mockReset();
  (ownership.resolveAutonomousOwnerUserId as Mock).mockReturnValue('test-operator');
});

// ═══════════════════════════════════════════════════════════════════════════
//  runAutonomousLoop — happy path dispatch
// ═══════════════════════════════════════════════════════════════════════════

describe('runAutonomousLoop — owner of manager workers', () => {
  it('with no recorded kicker, workers run as the first card-level owner the chain resolves', async () => {
    // Workers sit on the manager's rail, so one owner covers the whole run.
    // A scheduled kickoff with no kicker falls back to the card-level chain.
    const ownerlessCard = makeCard({ id: 'no-owner', title: 'No owner card' });
    const dispatchableCard = makeCard({ id: 'has-owner', title: 'Has owner card' });
    const singleSlotEpic = { ...ACTIVE_EPIC, autonomous_max_concurrent: 1 } as KanbanEpicRow;
    const stmts = makeStmts({
      getAutonomousEpic: { get: vi.fn(() => singleSlotEpic) },
      getKanbanEpic: { get: vi.fn(() => singleSlotEpic) },
      // Ordered: the owner-less card is first (e.g. highest priority).
      getEligibleAutonomousCards: { all: vi.fn(() => [ownerlessCard, dispatchableCard]) },
      getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
      getKanbanCardsByEpic: { all: vi.fn(() => [ownerlessCard, dispatchableCard]) },
    });
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(makeProject());
    mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
    const ownership = await import('./session-ownership.js');
    (ownership.resolveAutonomousOwnerUserId as Mock).mockImplementation(
      (card: KanbanCardRow | null) => (card?.id === 'has-owner' ? 'operator-user' : null),
    );
    initAutonomous(deps as never);

    await runAutonomousLoop('proj-1');

    // The top card takes the single slot, run as the resolved owner.
    expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
    expect(stmts.createSession.run.mock.calls[0][2]).toBe('No owner card');
    expect(ownership.setSessionOwner).toHaveBeenCalledWith(expect.any(String), 'operator-user');
  });
});

describe('runAutonomousLoop — owner attribution', () => {
  it('attributes the spawned session to the epic kicker', async () => {
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
    // The real chain: card creator first, then the epic's kicker.
    mockResolveAutonomousOwner.mockImplementation(
      (c: { created_by?: string } | null, e: { autonomous_enabled_by?: string | null }) =>
        c?.created_by ?? e?.autonomous_enabled_by ?? null,
    );

    initAutonomous(deps as never);
    await runAutonomousLoop('proj-1');

    // The kicker owns the epic's workers (they sit on the manager's rail), so
    // the chain is asked with no card first and the card creator is not used.
    const [calledCard, calledEpic] = mockResolveAutonomousOwner.mock.calls[0] as [unknown, unknown];
    expect(calledCard).toBeNull();
    expect((calledEpic as { id: string }).id).toBe('epic-1');

    expect(mockSetSessionOwner).toHaveBeenCalledTimes(1);
    const sessionId = stmts.createSession.run.mock.calls[0]?.[0] as string;
    expect(mockSetSessionOwner).toHaveBeenCalledWith(sessionId, 'enabler-user');
  });

  it('skips dispatch when owner chain resolves to null (no credential borrower)', async () => {
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

    expect(mockResolveAutonomousOwner).toHaveBeenCalled();
    expect(stmts.createSession.run).not.toHaveBeenCalled();
    expect(mockSetSessionOwner).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  runAutonomousLoop — role exclusion
// ═══════════════════════════════════════════════════════════════════════════

function recordingManager(overrides: Partial<Record<keyof EpicManagerPort, Mock>> = {}) {
  return {
    offerReady: vi.fn(),
    hasLiveManager: vi.fn(() => true),
    liveOffers: vi.fn((): string[] => []),
    withdrawOffer: vi.fn(),
    isOffered: vi.fn(() => false),
    isHeld: vi.fn(() => false),
    isAtRetryCap: vi.fn(() => false),
    noteWorkerStarted: vi.fn(),
    handOver: vi.fn(() => false),
    noteWorkerEvent: vi.fn(),
    observeCards: vi.fn(),
    kickoff: vi.fn(),
    pause: vi.fn(),
    noteRetryCapRefusal: vi.fn(),
    ...overrides,
  };
}

function epicDeps(cards: KanbanCardRow[], epic: KanbanEpicRow = ACTIVE_EPIC) {
  for (const card of cards) cardRegistry.set(card.id, card);
  epicRegistry.set(epic.id, epic);
  const stmts = makeStmts({
    getAutonomousEpic: { get: vi.fn(() => epic) },
    getEligibleAutonomousCards: { all: vi.fn(() => cards) },
    getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
    getKanbanCardsByEpic: { all: vi.fn(() => cards) },
  });
  const markSessionSpawnedFrom = { run: vi.fn() };
  (stmts as unknown as Record<string, unknown>).markSessionSpawnedFrom = markSessionSpawnedFrom;
  const deps = makeDeps(stmts);
  deps.findProject.mockReturnValue(makeProject());
  mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
  return { stmts, deps, markSessionSpawnedFrom };
}

describe('autonomous tick with an epic manager', () => {
  it('offers ready cards to the manager instead of spawning workers', async () => {
    const card = makeCard({ id: 'ready-1', title: 'Ready card' });
    const { stmts, deps } = epicDeps([card]);
    const manager = recordingManager();
    initAutonomous({ ...deps, epicManager: manager } as never);

    await runAutonomousLoop('proj-1');

    expect(manager.offerReady).toHaveBeenCalledTimes(1);
    const args = manager.offerReady.mock.calls[0][0] as {
      ready: ReadyCardOffer[];
      ownerUserId: string;
    };
    expect(args.ready.map((r) => r.card.id)).toEqual(['ready-1']);
    expect(args.ready[0].agentId).toBe('dev-1');
    expect(args.ownerUserId).toBe('test-operator');
    expect(stmts.createSession.run).not.toHaveBeenCalled();
    expect(stmts.moveKanbanCard.run).not.toHaveBeenCalled();
    expect(deps.handleChat).not.toHaveBeenCalled();
  });

  it('does not re-offer a card the manager has not answered, and offers hold slots', async () => {
    const a = makeCard({ id: 'a', title: 'A' });
    const b = makeCard({ id: 'b', title: 'B' });
    const epic = { ...ACTIVE_EPIC, autonomous_max_concurrent: 2 } as KanbanEpicRow;
    const { deps } = epicDeps([a, b], epic);
    const manager = recordingManager({
      isOffered: vi.fn((id: string) => id === 'a'),
      liveOffers: vi.fn(() => ['a']),
    });
    initAutonomous({ ...deps, epicManager: manager } as never);

    await runAutonomousLoop('proj-1');

    const ready = (manager.offerReady.mock.calls[0][0] as { ready: ReadyCardOffer[] }).ready;
    expect(ready.map((r) => r.card.id)).toEqual(['b']);
  });

  it('offers nothing while unanswered offers fill the cap', async () => {
    const offered = makeCard({ id: 'offered' });
    const card = makeCard({ id: 'a' });
    const epic = { ...ACTIVE_EPIC, autonomous_max_concurrent: 1 } as KanbanEpicRow;
    const { deps } = epicDeps([card], epic);
    cardRegistry.set(offered.id, offered);
    const manager = recordingManager({ liveOffers: vi.fn(() => ['offered']) });
    initAutonomous({ ...deps, epicManager: manager } as never);

    await runAutonomousLoop('proj-1');

    expect(manager.offerReady).not.toHaveBeenCalled();
  });

  it('skips cards the manager holds', async () => {
    const card = makeCard({ id: 'held' });
    const { deps } = epicDeps([card]);
    const manager = recordingManager({ isHeld: vi.fn(() => true) });
    initAutonomous({ ...deps, epicManager: manager } as never);

    await runAutonomousLoop('proj-1');

    expect(manager.offerReady).not.toHaveBeenCalled();
  });

  it('hands the epic cards to the manager for the Done diff every tick', async () => {
    const card = makeCard({ id: 'a' });
    const { deps } = epicDeps([card]);
    const manager = recordingManager();
    initAutonomous({ ...deps, epicManager: manager } as never);

    await runAutonomousLoop('proj-1');

    expect(manager.observeCards).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'epic-1' }),
      [card],
      expect.objectContaining({ 'col-done': 'Done' }),
    );
  });

  it('starting an epic or phase (boot restore included) never starts a manager', async () => {
    const { stmts, deps } = epicDeps([]);
    const manager = recordingManager({ hasLiveManager: vi.fn(() => false) });
    initAutonomous({ ...deps, epicManager: manager } as never);
    const epic = { ...ACTIVE_EPIC, autonomous_enabled_by: 'kicker' } as KanbanEpicRow;

    // index.ts restores every autonomous epic and running phase through these.
    scheduleAutonomousEpic('proj-1', epic);
    scheduleAutonomousPhase('proj-1', {
      id: 'phase-1',
      epic_id: 'epic-1',
      board_id: 'board-1',
      name: 'Phase 1',
      autonomous: 1,
      autonomous_running: 1,
      autonomous_enabled_by: 'kicker',
    } as unknown as KanbanPhaseRow);
    await new Promise((r) => setTimeout(r, 0));

    expect(manager.kickoff).not.toHaveBeenCalled();
    expect(manager.offerReady).not.toHaveBeenCalled();
    expect(stmts.createSession.run).not.toHaveBeenCalled();

    const stopped = { ...epic, autonomous: 0 } as KanbanEpicRow;
    epicRegistry.set(stopped.id, stopped);
    scheduleAutonomousEpic('proj-1', stopped);
    expect(manager.pause).toHaveBeenCalledWith('epic-1');
  });

  it('an epic with no live manager offers nothing and logs that once, not every tick', async () => {
    const card = makeCard({ id: 'ready-1', title: 'Ready card' });
    const { stmts, deps } = epicDeps([card]);
    let live = false;
    const manager = recordingManager({ hasLiveManager: vi.fn(() => live) });
    initAutonomous({ ...deps, epicManager: manager } as never);
    resetEpicManagerPresenceForTest();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const noSessionLines = () =>
      log.mock.calls.filter((c) => String(c[0]).includes('No epic session')).length;

    await runAutonomousLoop('proj-1');
    await runAutonomousLoop('proj-1');
    await runAutonomousLoop('proj-1');

    expect(manager.offerReady).not.toHaveBeenCalled();
    expect(stmts.createSession.run).not.toHaveBeenCalled();
    expect(noSessionLines()).toBe(1);

    // A person links a manager: offers resume. Losing it again logs again.
    live = true;
    await runAutonomousLoop('proj-1');
    expect(manager.offerReady).toHaveBeenCalledTimes(1);
    live = false;
    await runAutonomousLoop('proj-1');
    expect(noSessionLines()).toBe(2);
    log.mockRestore();
  });

  it('wakes the manager when the epic completes', async () => {
    const done = makeCard({ id: 'done-1', column_id: 'col-done' });
    const { stmts, deps } = epicDeps([done]);
    // Completion turns the epic off; the re-read must see that.
    stmts.updateKanbanEpic.run.mockImplementation(() =>
      epicRegistry.set('epic-1', { ...ACTIVE_EPIC, autonomous: 0 } as KanbanEpicRow),
    );
    const manager = recordingManager();
    initAutonomous({ ...deps, epicManager: manager } as never);

    await runAutonomousLoop('proj-1');

    expect(manager.noteWorkerEvent).toHaveBeenCalledWith(
      'epic-1',
      expect.objectContaining({ kind: 'epic_complete' }),
    );
  });
});

describe('spawnEpicWorkerForCard', () => {
  it('claims the card, links session and card, and parents the worker to the manager', async () => {
    const card = makeCard({ id: 'c1', title: 'Payment form', description: 'Card text' });
    const { stmts, deps, markSessionSpawnedFrom } = epicDeps([card]);
    const manager = recordingManager();
    initAutonomous({ ...deps, epicManager: manager } as never);

    const result = spawnEpicWorkerForCard({
      projectId: 'proj-1',
      cardId: 'c1',
      agentId: 'dev-2',
      prompt: 'Manager brief: build the payment form.',
      ownerUserId: 'kicker',
      parentSessionId: 'manager-session',
    });
    expect(result.status).toBe('started');
    if (result.status !== 'started') return;
    await result.turn;

    expect(result.agentId).toBe('dev-2');
    expect(stmts.markCardDispatchedByAutonomous.run).toHaveBeenCalledWith('c1');
    expect(stmts.moveKanbanCard.run).toHaveBeenCalledWith('col-progress', 0, 'c1');
    expect(markSessionSpawnedFrom.run).toHaveBeenCalledWith('manager-session', result.sessionId);
    // Card stamped with the worker session and the agent as assignee.
    const update = stmts.updateKanbanCard.run.mock.calls.at(-1)!;
    expect(update[3]).toBe('Dev Two');
    expect(update[5]).toBe(result.sessionId);
    const ownership = await import('./session-ownership.js');
    expect(ownership.setSessionOwner).toHaveBeenCalledWith(result.sessionId, 'kicker');
    expect(manager.noteWorkerStarted).toHaveBeenCalledWith('c1', 'epic-1');
    // The worker gets the manager's brief plus the card-link contract.
    const content = deps.handleChat.mock.calls[0][1].content as string;
    expect(content).toContain('Manager brief: build the payment form.');
    expect(content).toContain('linked to kanban card `c1`');
    // The card of record goes in whole, with the manager's brief on top.
    expect(content).toContain('# Task: Payment form');
    expect(content).toContain('Card text');
    expect(content).toContain('## Brief from the epic manager');
    expect(mockMarkFinalizeAutomationFn).toHaveBeenCalledWith(
      expect.anything(),
      result.sessionId,
      'push',
    );
  });

  it('refuses when the epic is paused', () => {
    const card = makeCard({ id: 'c1' });
    const paused = { ...ACTIVE_EPIC, autonomous: 0 } as KanbanEpicRow;
    const { stmts, deps } = epicDeps([card], paused);
    initAutonomous({ ...deps, epicManager: recordingManager() } as never);

    const result = spawnEpicWorkerForCard({ projectId: 'proj-1', cardId: 'c1', ownerUserId: 'k' });

    expect(result).toMatchObject({ status: 'refused', code: 'paused' });
    expect(stmts.createSession.run).not.toHaveBeenCalled();
  });

  it('refuses a card that is still blocked, whatever the manager forwards', () => {
    const card = makeCard({ id: 'c1', title: 'Blocked' });
    const { stmts, deps } = epicDeps([card]);
    stmts.getBlockersForBoard.all.mockReturnValue([
      {
        card_id: 'c1',
        blocked_by_card_id: 'up',
        blocker_id: 'up',
        blocker_title: 'Upstream',
        blocker_column_id: 'col-progress',
        blocker_column_name: 'In Progress',
        blocked_id: 'c1',
        blocked_title: 'Blocked',
        blocked_column_id: 'col-todo',
        blocked_column_name: 'To Do',
      },
    ]);
    initAutonomous({ ...deps, epicManager: recordingManager() } as never);

    const result = spawnEpicWorkerForCard({ projectId: 'proj-1', cardId: 'c1', ownerUserId: 'k' });

    expect(result).toMatchObject({ status: 'refused', code: 'ineligible' });
    expect(stmts.moveKanbanCard.run).not.toHaveBeenCalled();
  });

  it('refuses a card already claimed by another start', () => {
    const card = makeCard({ id: 'c1', column_id: 'col-progress', assignee: 'Dev One' });
    const { stmts, deps } = epicDeps([card]);
    initAutonomous({ ...deps, epicManager: recordingManager() } as never);

    const result = spawnEpicWorkerForCard({ projectId: 'proj-1', cardId: 'c1', ownerUserId: 'k' });

    expect(result).toMatchObject({ status: 'refused', code: 'ineligible' });
    expect(stmts.createSession.run).not.toHaveBeenCalled();
  });

  it('refuses past the retry cap and tells the manager', () => {
    const card = makeCard({ id: 'c1' });
    const { stmts, deps } = epicDeps([card]);
    const manager = recordingManager({ isAtRetryCap: vi.fn(() => true) });
    initAutonomous({ ...deps, epicManager: manager } as never);

    const result = spawnEpicWorkerForCard({ projectId: 'proj-1', cardId: 'c1', ownerUserId: 'k' });

    expect(result).toMatchObject({ status: 'refused', code: 'retry_cap' });
    expect(manager.noteRetryCapRefusal).toHaveBeenCalledWith('epic-1', 'c1');
    expect(stmts.createSession.run).not.toHaveBeenCalled();
  });

  it('falls back to routing when the manager names an agent that cannot take tickets', async () => {
    const card = makeCard({ id: 'c1' });
    const { deps } = epicDeps([card]);
    deps.findProject.mockReturnValue(
      makeProject({
        agents: [
          { id: 'dev-1', name: 'Dev One', role: 'sub', engine: 'claude-code' },
          { id: 'docs', name: 'Docs', role: 'docs', engine: 'claude-code' },
        ] as Project['agents'],
      }),
    );
    initAutonomous({ ...deps, epicManager: recordingManager() } as never);

    const result = spawnEpicWorkerForCard({
      projectId: 'proj-1',
      cardId: 'c1',
      agentId: 'docs',
      ownerUserId: 'k',
    });

    expect(result).toMatchObject({ status: 'started', agentId: 'dev-1' });
  });
});

describe('epic manager holds and retry exhaustion', () => {
  it('a hold set after the offer stops the pending forward from starting a worker', async () => {
    const card = makeCard({ id: 'c1', title: 'Payment form' });
    const { stmts, deps } = epicDeps([card]);
    let held = false;
    const manager = recordingManager({ isHeld: vi.fn(() => held) });
    initAutonomous({ ...deps, epicManager: manager } as never);

    // Offered while not held.
    await runAutonomousLoop('proj-1');
    expect(manager.offerReady).toHaveBeenCalledTimes(1);

    // The manager (or a person) holds it before the countdown fires.
    held = true;
    const result = spawnEpicWorkerForCard({ projectId: 'proj-1', cardId: 'c1', ownerUserId: 'k' });

    expect(result).toMatchObject({ status: 'refused', code: 'held' });
    expect(stmts.moveKanbanCard.run).not.toHaveBeenCalled();
    expect(stmts.createSession.run).not.toHaveBeenCalled();
  });

  it('re-reads the hold label inside the claim', () => {
    const card = makeCard({ id: 'c1', labels: 'backend, hold' });
    const { stmts, deps } = epicDeps([card]);
    initAutonomous({ ...deps, epicManager: recordingManager() } as never);

    const result = spawnEpicWorkerForCard({ projectId: 'proj-1', cardId: 'c1', ownerUserId: 'k' });

    expect(result).toMatchObject({ status: 'refused', code: 'held' });
    expect(stmts.markCardDispatchedByAutonomous.run).not.toHaveBeenCalled();
    expect(stmts.moveKanbanCard.run).not.toHaveBeenCalled();
  });

  it('reports a requeued card at the retry cap instead of skipping it silently', async () => {
    const card = makeCard({ id: 'c1' });
    const { deps } = epicDeps([card]);
    const manager = recordingManager({
      isAtRetryCap: vi.fn(() => true),
      isHeld: vi.fn(() => true),
    });
    initAutonomous({ ...deps, epicManager: manager } as never);

    await runAutonomousLoop('proj-1');

    expect(manager.noteRetryCapRefusal).toHaveBeenCalledWith('epic-1', 'c1');
    expect(manager.offerReady).not.toHaveBeenCalled();
  });
});

describe('explicit phase kickoff hands over the manager', () => {
  it('Run phase by another user hands the epic manager to them', async () => {
    const phase = {
      id: 'phase-1',
      epic_id: 'epic-1',
      board_id: 'board-1',
      name: 'Phase 1',
      autonomous: 1,
      autonomous_running: 0,
      autonomous_max_concurrent: 1,
      autonomous_model: null,
      autonomous_interval: 60,
      description: null,
    } as unknown as KanbanPhaseRow;
    const { stmts, deps } = epicDeps([]);
    (stmts as unknown as Record<string, unknown>).getKanbanPhase = { get: vi.fn(() => phase) };
    (stmts as unknown as Record<string, unknown>).setPhaseAutonomousEnabledBy = { run: vi.fn() };
    (stmts as unknown as Record<string, unknown>).setPhaseAutonomousRunning = { run: vi.fn() };
    const manager = recordingManager();
    initAutonomous({ ...deps, epicManager: manager } as never);

    await startAutonomousPhase('proj-1', 'phase-1', 'user-b');

    expect(manager.handOver).toHaveBeenCalledWith('epic-1', 'user-b');
  });
});

describe('offers and worker starts share one readiness check', () => {
  it('an offered card put on hold releases its slot on the next tick', async () => {
    const held = makeCard({ id: 'held', labels: 'hold' });
    const next = makeCard({ id: 'next', title: 'Next' });
    const epic = { ...ACTIVE_EPIC, autonomous_max_concurrent: 1 } as KanbanEpicRow;
    const { deps } = epicDeps([next], epic);
    cardRegistry.set(held.id, held);
    const manager = recordingManager({ liveOffers: vi.fn(() => ['held']) });
    initAutonomous({ ...deps, epicManager: manager } as never);

    await runAutonomousLoop('proj-1');

    expect(manager.withdrawOffer).toHaveBeenCalledWith('held');
    const ready = (manager.offerReady.mock.calls[0][0] as { ready: ReadyCardOffer[] }).ready;
    expect(ready.map((r) => r.card.id)).toEqual(['next']);
  });

  it('offers for deleted cards and cards moved off the epic stop holding slots', async () => {
    const moved = makeCard({ id: 'moved', epic_id: 'other-epic' });
    const next = makeCard({ id: 'next' });
    const epic = { ...ACTIVE_EPIC, autonomous_max_concurrent: 2 } as KanbanEpicRow;
    const { stmts, deps } = epicDeps([next], epic);
    cardRegistry.set(moved.id, moved);
    stmts.getKanbanCard.get.mockImplementation((id: string) =>
      id === 'deleted' ? undefined : (cardRegistry.get(id) ?? makeCard({ id })),
    );
    const manager = recordingManager({ liveOffers: vi.fn(() => ['deleted', 'moved']) });
    initAutonomous({ ...deps, epicManager: manager } as never);

    await runAutonomousLoop('proj-1');

    expect(manager.withdrawOffer).toHaveBeenCalledWith('deleted');
    expect(manager.withdrawOffer).toHaveBeenCalledWith('moved');
    expect(manager.offerReady).toHaveBeenCalledTimes(1);
  });

  it('reroutes a worker start away from an agent already at its limit', () => {
    const busyCard = makeCard({ id: 'busy-card', column_id: 'col-progress' });
    const card = makeCard({ id: 'c1' });
    const epic = { ...ACTIVE_EPIC, autonomous_max_concurrent: 1 } as KanbanEpicRow;
    const { stmts, deps } = epicDeps([card], epic);
    // dev-1 already runs a worker in this epic. The scope cap counts the
    // epic's cards; give it room so only the agent limit is in play.
    deps.getActiveProcesses.mockReturnValue(new Map([['busy-session', {}]]));
    stmts.getSession.get.mockImplementation((id: string) =>
      id === 'busy-session' ? { id, agent_id: 'dev-1' } : null,
    );
    stmts.getKanbanCardBySession.get.mockImplementation((id: string) =>
      id === 'busy-session' ? { ...busyCard, dispatched_by_autonomous: 1 } : undefined,
    );
    initAutonomous({ ...deps, epicManager: recordingManager() } as never);

    const result = spawnEpicWorkerForCard({
      projectId: 'proj-1',
      cardId: 'c1',
      agentId: 'dev-1',
      ownerUserId: 'k',
    });

    expect(result).toMatchObject({ status: 'started', agentId: 'dev-2' });
  });

  it('refuses a worker start when every agent is at its limit', () => {
    const card = makeCard({ id: 'c1' });
    const epic = { ...ACTIVE_EPIC, autonomous_max_concurrent: 1 } as KanbanEpicRow;
    const { stmts, deps } = epicDeps([card], epic);
    deps.getActiveProcesses.mockReturnValue(
      new Map([
        ['s1', {}],
        ['s2', {}],
      ]),
    );
    stmts.getSession.get.mockImplementation((id: string) =>
      id === 's1' ? { id, agent_id: 'dev-1' } : id === 's2' ? { id, agent_id: 'dev-2' } : null,
    );
    stmts.getKanbanCardBySession.get.mockImplementation(() =>
      makeCard({ id: 'x', column_id: 'col-done', dispatched_by_autonomous: 1 }),
    );
    initAutonomous({ ...deps, epicManager: recordingManager() } as never);

    const result = spawnEpicWorkerForCard({ projectId: 'proj-1', cardId: 'c1', ownerUserId: 'k' });

    expect(result).toMatchObject({ status: 'refused', code: 'agent_busy' });
    expect(stmts.moveKanbanCard.run).not.toHaveBeenCalled();
  });
});

describe('worker prompt keeps the full card', () => {
  it('requirements past the wake-message cutoff still reach the worker', async () => {
    const acceptance = '## Acceptance criteria\n- [ ] Refunds post to the ledger within 5s';
    const description = `${'Background. '.repeat(500)}\n\n${acceptance}`;
    expect(description.length).toBeGreaterThan(4_000);
    const card = makeCard({ id: 'long', title: 'Refunds', description });
    const { deps } = epicDeps([card]);
    initAutonomous({ ...deps, epicManager: recordingManager() } as never);

    const result = spawnEpicWorkerForCard({
      projectId: 'proj-1',
      cardId: 'long',
      prompt: 'Builds on the ledger API from card a1.',
      ownerUserId: 'k',
    });
    if (result.status !== 'started') throw new Error(`refused: ${JSON.stringify(result)}`);
    await result.turn;

    const content = deps.handleChat.mock.calls[0][1].content as string;
    expect(content).toContain(description);
    expect(content).toContain('Refunds post to the ledger within 5s');
    expect(content).toContain('Builds on the ledger API from card a1.');
  });
});

describe('phase completion reaches the manager with its phase', () => {
  it('names the completed phase on the event', async () => {
    const phase = {
      id: 'phase-1',
      epic_id: 'epic-1',
      board_id: 'board-1',
      name: 'Phase 1',
      autonomous: 1,
      autonomous_running: 1,
      autonomous_max_concurrent: 1,
      autonomous_model: null,
      autonomous_interval: 60,
      description: null,
    } as unknown as KanbanPhaseRow;
    const done = makeCard({ id: 'd1', column_id: 'col-done', phase_id: 'phase-1' });
    const { stmts, deps } = epicDeps([done], { ...ACTIVE_EPIC, autonomous: 0 } as KanbanEpicRow);
    let running = 1;
    const extra = stmts as unknown as Record<string, unknown>;
    extra.getKanbanPhase = { get: vi.fn(() => ({ ...phase, autonomous_running: running })) };
    extra.getKanbanCardsByPhase = { all: vi.fn(() => [done]) };
    extra.getKanbanPhasesByEpic = { all: vi.fn(() => [phase]) };
    extra.updateKanbanPhase = { run: vi.fn() };
    extra.setPhaseAutonomousRunning = { run: vi.fn((v: number) => (running = v)) };
    const manager = recordingManager();
    initAutonomous({ ...deps, epicManager: manager } as never);

    await runAutonomousLoopForPhase('proj-1', 'phase-1');

    expect(manager.noteWorkerEvent).toHaveBeenCalledWith(
      'epic-1',
      expect.objectContaining({ kind: 'phase_complete', phaseId: 'phase-1' }),
    );
  });
});

describe('flipping orchestratedEpics on a running epic', () => {
  /** A running epic whose project setting the test flips between ticks. */
  function flippable(cards: KanbanCardRow[], orchestratedEpics: boolean) {
    const { stmts, deps } = epicDeps(cards);
    const project = makeProject({ orchestratedEpics });
    deps.findProject.mockReturnValue(project);
    const extra = stmts as unknown as Record<string, unknown>;
    extra.getKanbanBoard = { get: vi.fn(() => ({ id: 'board-1', project_id: 'proj-1' })) };
    extra.getKanbanEpics = { all: vi.fn(() => [ACTIVE_EPIC]) };
    const manager = recordingManager();
    initAutonomous({ ...deps, epicManager: manager } as never);
    autonomousProjects.add('proj-1');
    return { stmts, deps, project, manager };
  }

  it('on to off: the managers pause and the next tick starts workers per card', async () => {
    const card = makeCard({ id: 'flip-1', title: 'Flip card' });
    const { stmts, project, manager } = flippable([card], true);

    await runAutonomousLoop('proj-1');
    expect(manager.offerReady).toHaveBeenCalledTimes(1);
    expect(stmts.createSession.run).not.toHaveBeenCalled();

    project.orchestratedEpics = false;
    manager.observeCards.mockClear();
    noteOrchestratedEpicsChanged('proj-1');
    await vi.waitFor(() => expect(stmts.createSession.run).toHaveBeenCalledTimes(1));

    // Offers lapse and pending Auto starts are cancelled on the old manager.
    expect(manager.pause).toHaveBeenCalledWith(ACTIVE_EPIC.id);
    expect(manager.offerReady).toHaveBeenCalledTimes(1);
    expect(manager.observeCards).not.toHaveBeenCalled();
    expect(manager.noteWorkerStarted).not.toHaveBeenCalled();
    expect(stmts.moveKanbanCard.run).toHaveBeenCalledWith('col-progress', 0, 'flip-1');
  });

  it('off to on: the next tick offers ready cards instead of starting workers', async () => {
    const first = makeCard({ id: 'off-1', title: 'Started per card' });
    const second = makeCard({ id: 'on-1', title: 'Offered to the manager' });
    const { stmts, deps, project, manager } = flippable([first], false);

    await runAutonomousLoop('proj-1');
    expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
    expect(manager.offerReady).not.toHaveBeenCalled();
    const prompt = (deps.handleChat.mock.calls[0][1] as { content: string }).content;
    expect(prompt).toContain('assigned this task by the autonomous dispatch system');

    cardRegistry.set(second.id, second);
    stmts.getEligibleAutonomousCards.all.mockReturnValue([second]);
    stmts.getKanbanCardsByEpic.all.mockReturnValue([first, second]);
    project.orchestratedEpics = true;
    noteOrchestratedEpicsChanged('proj-1');
    await vi.waitFor(() => expect(manager.offerReady).toHaveBeenCalledTimes(1));

    // Turning it on pauses nothing; the manager just starts getting offers.
    expect(manager.pause).not.toHaveBeenCalled();
    const ready = (manager.offerReady.mock.calls[0][0] as { ready: ReadyCardOffer[] }).ready;
    expect(ready.map((r) => r.card.id)).toEqual(['on-1']);
    expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
  });

  it('with the setting off, the manager is never consulted for holds or retry caps', async () => {
    const card = makeCard({ id: 'labelled', labels: 'hold' });
    const { stmts, manager } = flippable([card], false);
    manager.isHeld.mockReturnValue(true);
    manager.isAtRetryCap.mockReturnValue(true);

    await runAutonomousLoop('proj-1');

    expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
    expect(manager.isHeld).not.toHaveBeenCalled();
    expect(manager.isAtRetryCap).not.toHaveBeenCalled();
    expect(manager.hasLiveManager).not.toHaveBeenCalled();
  });
});

describe('per-card dispatch re-reads the board between worker starts', () => {
  /** Two ready cards; the first worker's start stays pending until released. */
  function pendingFirstTurn() {
    const first = makeCard({ id: 'first', title: 'First' });
    const second = makeCard({ id: 'second', title: 'Second' });
    const epic = { ...ACTIVE_EPIC, autonomous_max_concurrent: 2 } as KanbanEpicRow;
    const { stmts, deps } = epicDeps([first, second], epic);
    const project = makeProject({ orchestratedEpics: false });
    deps.findProject.mockReturnValue(project);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    deps.prepareSessionEnv = vi.fn(async () => {
      entered();
      await gate;
    });
    const manager = recordingManager();
    initAutonomous({ ...deps, epicManager: manager } as never);
    return { stmts, project, manager, release, started, second };
  }

  it('stops starting cards when orchestrated epics turn on mid-batch', async () => {
    const { stmts, project, manager, release, started } = pendingFirstTurn();
    const tick = runAutonomousLoop('proj-1');
    await started;
    project.orchestratedEpics = true;
    release();
    await tick;

    expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
    expect(stmts.moveKanbanCard.run).not.toHaveBeenCalledWith('col-progress', 0, 'second');
    expect(manager.noteWorkerStarted).not.toHaveBeenCalled();
  });

  it('skips a queued card moved to another epic while the previous start was pending', async () => {
    const { stmts, release, started, second } = pendingFirstTurn();
    const tick = runAutonomousLoop('proj-1');
    await started;
    cardRegistry.set(second.id, { ...second, epic_id: 'another-epic' });
    release();
    await tick;

    expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
    expect(stmts.moveKanbanCard.run).not.toHaveBeenCalledWith('col-progress', 0, 'second');
  });

  it('skips a queued card moved to another phase while the previous start was pending', async () => {
    const { stmts, release, started, second } = pendingFirstTurn();
    const tick = runAutonomousLoop('proj-1');
    await started;
    cardRegistry.set(second.id, { ...second, phase_id: 'phase-elsewhere' });
    release();
    await tick;

    expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
    expect(stmts.moveKanbanCard.run).not.toHaveBeenCalledWith('col-progress', 0, 'second');
  });

  it('skips a queued card that gained an open blocker while the previous start was pending', async () => {
    const { stmts, release, started, second } = pendingFirstTurn();
    const tick = runAutonomousLoop('proj-1');
    await started;
    stmts.getBlockersForBoard.all.mockReturnValue([
      {
        card_id: second.id,
        blocked_by_card_id: 'upstream',
        blocker_id: 'upstream',
        blocker_title: 'Upstream',
        blocker_column_id: 'col-progress',
        blocker_column_name: 'In Progress',
        blocked_id: second.id,
        blocked_title: second.title,
        blocked_column_id: 'col-todo',
        blocked_column_name: 'To Do',
      },
    ]);
    release();
    await tick;

    expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
    expect(stmts.moveKanbanCard.run).not.toHaveBeenCalledWith('col-progress', 0, 'second');
  });

  it('skips a queued build card once a spec decision reopens while the previous start was pending', async () => {
    const { stmts, release, started } = pendingFirstTurn();
    const tick = runAutonomousLoop('proj-1');
    await started;
    stmts.countOpenKanbanSpecItemsByEpic!.get.mockReturnValue({ n: 1 });
    release();
    await tick;

    expect(stmts.createSession.run).toHaveBeenCalledTimes(1);
    expect(stmts.moveKanbanCard.run).not.toHaveBeenCalledWith('col-progress', 0, 'second');
  });

  it('starts a queued card from its current row, not the row the tick queued', async () => {
    const { stmts, release, started, second } = pendingFirstTurn();
    const tick = runAutonomousLoop('proj-1');
    await started;
    cardRegistry.set(second.id, { ...second, title: 'Second, renamed' });
    release();
    await tick;

    expect(stmts.createSession.run).toHaveBeenCalledTimes(2);
    const stamped = stmts.updateKanbanCard.run.mock.calls.find((call) => call.at(-1) === 'second');
    expect(stamped?.[0]).toBe('Second, renamed');
  });
});
