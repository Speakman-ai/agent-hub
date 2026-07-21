import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { KanbanCardRow, KanbanEpicRow, KanbanPhaseRow, Project } from './types.js';

// ─── Module mocks (hoisted before imports) ────────────────────────────────
vi.mock('node-cron', () => ({
  default: { schedule: vi.fn(() => ({ stop: vi.fn() })) },
  schedule: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock('./routes/board.js', () => ({ getOrCreateBoard: vi.fn() }));

vi.mock('./config.js', () => ({
  default: { apiKey: null, dataDir: '/tmp/agent-hub-epic-start-test' },
  defaultModelForEngine: vi.fn(() => 'mock-model'),
}));

vi.mock('./session-ship.js', () => ({
  markSessionAutoShipOnComplete: vi.fn(),
  markSessionFinalizeAutomation: vi.fn(),
}));

vi.mock('./session-ownership.js', () => ({
  setSessionOwner: vi.fn(),
  getOrgOwnerUserId: vi.fn(() => null),
  inheritOwnerFromSession: vi.fn(),
  resolveOwnerUserId: vi.fn(() => null),
  resolveAutonomousOwnerUserId: vi.fn(() => 'test-operator'),
  userOwnsSession: vi.fn(() => true),
}));

vi.mock('./secrets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secrets.js')>();
  return { ...actual, getDevHubApiKey: vi.fn(async () => 'ahub_mock_dev_key') };
});

const { initAutonomous, startAutonomousEpicChain, autonomousCrons, autonomousProjects } =
  await import('./autonomous.js');
const { getOrCreateBoard } = await import('./routes/board.js');
const mockGetOrCreateBoard = getOrCreateBoard as Mock;

// ─── Helpers ───────────────────────────────────────────────────────────────
const BOARD_COLS = [
  { id: 'col-todo', name: 'To Do' },
  { id: 'col-progress', name: 'In Progress' },
  { id: 'col-done', name: 'Done' },
];

function makeCard(overrides: Partial<KanbanCardRow> = {}): KanbanCardRow {
  return {
    id: 'card-1',
    column_id: 'col-todo',
    title: 'Build',
    epic_id: 'epic-1',
    phase_id: 'phase-1',
    ...overrides,
  } as unknown as KanbanCardRow;
}

function makePhase(overrides: Partial<KanbanPhaseRow> = {}): KanbanPhaseRow {
  return {
    id: 'phase-1',
    epic_id: 'epic-1',
    board_id: 'board-1',
    name: 'Phase 1',
    position: 0,
    autonomous: 1,
    autonomous_running: 0,
    autonomous_interval: 60,
    autonomous_max_concurrent: 1,
    autonomous_model: null,
    autonomous_send_it: 0,
    autonomous_enabled_by: null,
    description: null,
    ...overrides,
  } as unknown as KanbanPhaseRow;
}

const EPIC: KanbanEpicRow = {
  id: 'epic-1',
  board_id: 'board-1',
  name: 'Sprint 1',
  autonomous: 0,
} as unknown as KanbanEpicRow;

interface StmtOverrides {
  getKanbanEpic?: { get: Mock };
  getKanbanPhasesByEpic?: { all: Mock };
  getKanbanColumns?: { all: Mock };
  getKanbanCardsByPhase?: { all: Mock };
  getKanbanPhase?: { get: Mock };
  setPhaseAutonomousRunning?: { run: Mock };
  setPhaseAutonomousEnabledBy?: { run: Mock };
}

function makeStmts(o: StmtOverrides = {}) {
  return {
    getKanbanEpic: { get: vi.fn(() => EPIC) },
    getKanbanPhasesByEpic: { all: vi.fn(() => []) },
    getKanbanColumns: { all: vi.fn(() => BOARD_COLS) },
    getKanbanCardsByPhase: { all: vi.fn(() => []) },
    getKanbanPhase: { get: vi.fn(() => undefined) },
    setPhaseAutonomousRunning: { run: vi.fn() },
    setPhaseAutonomousEnabledBy: { run: vi.fn() },
    // Downstream-dispatch statements exercised by the fire-and-forget initial
    // phase dispatch after a `started` outcome — all inert so nothing dispatches.
    getEligibleAutonomousCardsByPhase: { all: vi.fn(() => []) },
    getEligibleAutonomousSpikeCardsByPhase: { all: vi.fn(() => []) },
    getEligibleAutonomousCards: { all: vi.fn(() => []) },
    getEligibleAutonomousSpikeCards: { all: vi.fn(() => []) },
    countOpenKanbanSpecItemsByPhase: { get: vi.fn(() => ({ n: 0 })) },
    countOpenKanbanSpecItemsByEpic: { get: vi.fn(() => ({ n: 0 })) },
    getKanbanSpecItemsByEpic: { all: vi.fn(() => []) },
    getKanbanCardsByEpic: { all: vi.fn(() => []) },
    getBlockersForBoard: { all: vi.fn(() => []) },
    updateKanbanPhase: { run: vi.fn() },
    ...o,
  };
}

function makeDeps(stmts: ReturnType<typeof makeStmts>) {
  return {
    stmts,
    broadcast: vi.fn(),
    findProject: vi.fn(() => ({ id: 'proj-1', name: 'P', agents: [] }) as unknown as Project),
    findAgent: vi.fn(() => null),
    handleChat: vi.fn(() => Promise.resolve()),
    handleCancel: vi.fn(),
    getActiveProcesses: vi.fn(() => new Map()),
    getProjects: vi.fn(() => []),
    getConfig: vi.fn(() => ({}) as never),
    getGhAuthenticatedUser: vi.fn(() => null),
    getDb: vi.fn(() => ({ transaction: (fn: (...a: unknown[]) => unknown) => fn })),
  };
}

beforeEach(() => {
  mockGetOrCreateBoard.mockReset();
  mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
  autonomousProjects.clear();
  for (const t of autonomousCrons.values()) t.stop?.();
  autonomousCrons.clear();
});

describe('startAutonomousEpicChain', () => {
  it('throws when the project is not found', async () => {
    const stmts = makeStmts();
    const deps = makeDeps(stmts);
    deps.findProject.mockReturnValue(undefined as never);
    initAutonomous(deps as never);
    await expect(startAutonomousEpicChain('nope', 'epic-1', 'op-1')).rejects.toThrow(
      /Project not found/,
    );
  });

  it('throws when the epic is not on the board', async () => {
    const stmts = makeStmts({ getKanbanEpic: { get: vi.fn(() => undefined) } });
    initAutonomous(makeDeps(stmts) as never);
    await expect(startAutonomousEpicChain('proj-1', 'epic-1', 'op-1')).rejects.toThrow(
      /Epic not found/,
    );
  });

  it('returns no_phases for an epic with zero phases', async () => {
    const stmts = makeStmts({ getKanbanPhasesByEpic: { all: vi.fn(() => []) } });
    initAutonomous(makeDeps(stmts) as never);
    const res = await startAutonomousEpicChain('proj-1', 'epic-1', 'op-1');
    expect(res).toEqual({ outcome: 'no_phases' });
  });

  it('returns all_complete when every phase card is Done', async () => {
    const phase = makePhase();
    const stmts = makeStmts({
      getKanbanPhasesByEpic: { all: vi.fn(() => [phase]) },
      getKanbanCardsByPhase: {
        all: vi.fn(() => [makeCard({ column_id: 'col-done' })]),
      },
    });
    initAutonomous(makeDeps(stmts) as never);
    const res = await startAutonomousEpicChain('proj-1', 'epic-1', 'op-1');
    expect(res.outcome).toBe('all_complete');
    expect(stmts.setPhaseAutonomousRunning.run).not.toHaveBeenCalled();
  });

  it('starts the leftmost armed phase with outstanding work, skipping completed ones', async () => {
    const done = makePhase({ id: 'phase-0', name: 'Phase 0', position: 0 });
    const target = makePhase({ id: 'phase-1', name: 'Phase 1', position: 1, autonomous: 1 });
    const cardsByPhase: Record<string, KanbanCardRow[]> = {
      'phase-0': [makeCard({ id: 'c0', phase_id: 'phase-0', column_id: 'col-done' })],
      'phase-1': [makeCard({ id: 'c1', phase_id: 'phase-1', column_id: 'col-todo' })],
    };
    const stmts = makeStmts({
      getKanbanPhasesByEpic: { all: vi.fn(() => [done, target]) },
      getKanbanCardsByPhase: { all: vi.fn((id: string) => cardsByPhase[id] ?? []) },
      getKanbanPhase: { get: vi.fn(() => ({ ...target, autonomous_running: 1 })) },
    });
    initAutonomous(makeDeps(stmts) as never);
    const res = await startAutonomousEpicChain('proj-1', 'epic-1', 'op-7');
    expect(res).toMatchObject({ outcome: 'started', phaseId: 'phase-1', phaseName: 'Phase 1' });
    // Ran the target phase under the operator identity.
    expect(stmts.setPhaseAutonomousEnabledBy.run).toHaveBeenCalledWith('op-7', 'phase-1');
    expect(stmts.setPhaseAutonomousRunning.run).toHaveBeenCalledWith(1, 'phase-1');
  });

  it('stops (without starting) when the leftmost phase with work has auto-dispatch off', async () => {
    const disabled = makePhase({ id: 'phase-1', name: 'Phase 1', autonomous: 0 });
    const stmts = makeStmts({
      getKanbanPhasesByEpic: { all: vi.fn(() => [disabled]) },
      getKanbanCardsByPhase: { all: vi.fn(() => [makeCard({ column_id: 'col-todo' })]) },
    });
    initAutonomous(makeDeps(stmts) as never);
    const res = await startAutonomousEpicChain('proj-1', 'epic-1', 'op-1');
    expect(res).toMatchObject({ outcome: 'stopped_disabled', phaseId: 'phase-1' });
    expect(stmts.setPhaseAutonomousRunning.run).not.toHaveBeenCalled();
    expect(stmts.setPhaseAutonomousEnabledBy.run).not.toHaveBeenCalled();
  });

  it('reports already_running when the leftmost phase with work is already dispatching', async () => {
    const running = makePhase({ id: 'phase-1', autonomous: 1, autonomous_running: 1 });
    const stmts = makeStmts({
      getKanbanPhasesByEpic: { all: vi.fn(() => [running]) },
      getKanbanCardsByPhase: { all: vi.fn(() => [makeCard({ column_id: 'col-progress' })]) },
    });
    initAutonomous(makeDeps(stmts) as never);
    const res = await startAutonomousEpicChain('proj-1', 'epic-1', 'op-1');
    expect(res).toMatchObject({ outcome: 'already_running', phaseId: 'phase-1' });
    expect(stmts.setPhaseAutonomousRunning.run).not.toHaveBeenCalled();
  });

  it('requires a resolvable operator to actually start a phase', async () => {
    const target = makePhase({ id: 'phase-1', autonomous: 1 });
    const stmts = makeStmts({
      getKanbanPhasesByEpic: { all: vi.fn(() => [target]) },
      getKanbanCardsByPhase: { all: vi.fn(() => [makeCard({ column_id: 'col-todo' })]) },
      getKanbanPhase: { get: vi.fn(() => target) },
    });
    initAutonomous(makeDeps(stmts) as never);
    // No operator id → startAutonomousPhase refuses (credential-owner rule).
    await expect(startAutonomousEpicChain('proj-1', 'epic-1', null)).rejects.toThrow(
      /Authentication required/,
    );
  });
});
