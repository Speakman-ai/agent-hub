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
  isPrMergeDirty,
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
    createSession: { run: vi.fn() },
    updateKanbanCard: { run: vi.fn() },
    moveKanbanCard: { run: vi.fn() },
    incrementCardIterations: { run: vi.fn() },
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
    expect(stmts.incrementCardIterations.run).not.toHaveBeenCalled();
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

    expect(stmts.incrementCardIterations.run).toHaveBeenCalledWith('ready-card');
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
    expect(stmts.incrementCardIterations.run).toHaveBeenCalledTimes(1);
    expect(stmts.incrementCardIterations.run).toHaveBeenCalledWith('r-card');
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
