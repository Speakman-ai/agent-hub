import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { KanbanEpicRow, Project } from './types.js';

// ─── Module mocks (hoisted before imports) ────────────────────────────────
vi.mock('node-cron', () => ({
  default: { schedule: vi.fn(() => ({ stop: vi.fn() })), validate: vi.fn(() => true) },
  schedule: vi.fn(() => ({ stop: vi.fn() })),
  validate: vi.fn(() => true),
}));

vi.mock('./routes/board.js', () => ({ getOrCreateBoard: vi.fn() }));

vi.mock('./autonomous.js', () => ({
  startAutonomousEpicChain: vi.fn(async () => ({ outcome: 'started', phaseName: 'Phase 1' })),
}));

// getStmts is only a fallback — every call site here passes an explicit `stmts`
// dep — but the ticker imports it, so it must resolve.
vi.mock('./db.js', () => ({ getStmts: vi.fn(() => ({})) }));

const {
  runScheduledEpicStart,
  initEpicStartSchedules,
  refreshEpicStartScheduleRegistration,
  unregisterEpicStartSchedule,
  stopAllEpicStartSchedules,
  getRegisteredEpicStartScheduleIds,
} = await import('./autonomous-start-schedule.js');

const { getOrCreateBoard } = await import('./routes/board.js');
const mockGetOrCreateBoard = getOrCreateBoard as Mock;
const { startAutonomousEpicChain } = await import('./autonomous.js');
const mockStartEpicChain = startAutonomousEpicChain as Mock;

function makeEpic(overrides: Partial<KanbanEpicRow> = {}): KanbanEpicRow {
  return {
    id: 'epic-1',
    board_id: 'board-1',
    name: 'Sprint 1',
    scheduled_start_cron: '0 9 * * 1',
    scheduled_start_timezone: 'America/New_York',
    scheduled_start_enabled: 1,
    scheduled_start_enabled_by: 'op-1',
    ...overrides,
  } as unknown as KanbanEpicRow;
}

const PROJECT = { id: 'proj-1', name: 'P' } as unknown as Project;

// A per-test stmts stand-in whose getKanbanEpic returns the current `epicRow`,
// so a test can flip the schedule fields and the ticker re-reads the new value.
let epicRow: KanbanEpicRow | undefined;
function makeStmts() {
  return {
    getKanbanEpic: { get: vi.fn(() => epicRow) },
    getStartScheduledEpicsByBoard: {
      all: vi.fn(() =>
        epicRow && epicRow.scheduled_start_enabled === 1 && epicRow.scheduled_start_cron
          ? [epicRow]
          : [],
      ),
    },
  };
}

beforeEach(() => {
  stopAllEpicStartSchedules();
  mockGetOrCreateBoard.mockReset();
  mockGetOrCreateBoard.mockReturnValue({ board: { id: 'board-1' } });
  mockStartEpicChain.mockClear();
  mockStartEpicChain.mockResolvedValue({ outcome: 'started', phaseName: 'Phase 1' });
  epicRow = makeEpic();
});

describe('runScheduledEpicStart — firing gate', () => {
  it('starts the epic chain under the owner when enabled + cron + owner', async () => {
    const stmts = makeStmts();
    await runScheduledEpicStart('proj-1', 'epic-1', {
      getProjects: () => [],
      stmts: stmts as never,
    });
    expect(mockStartEpicChain).toHaveBeenCalledWith('proj-1', 'epic-1', 'op-1');
  });

  it('does not fire when the schedule was disabled since registration', async () => {
    epicRow = makeEpic({ scheduled_start_enabled: 0 });
    const stmts = makeStmts();
    await runScheduledEpicStart('proj-1', 'epic-1', {
      getProjects: () => [],
      stmts: stmts as never,
    });
    expect(mockStartEpicChain).not.toHaveBeenCalled();
  });

  it('does not fire when the cron was cleared', async () => {
    epicRow = makeEpic({ scheduled_start_cron: null });
    const stmts = makeStmts();
    await runScheduledEpicStart('proj-1', 'epic-1', {
      getProjects: () => [],
      stmts: stmts as never,
    });
    expect(mockStartEpicChain).not.toHaveBeenCalled();
  });

  it('skips (and logs) when no owner resolves for credentials', async () => {
    epicRow = makeEpic({ scheduled_start_enabled_by: null });
    const stmts = makeStmts();
    const log = vi.fn();
    await runScheduledEpicStart('proj-1', 'epic-1', {
      getProjects: () => [],
      stmts: stmts as never,
      log,
    });
    expect(mockStartEpicChain).not.toHaveBeenCalled();
    expect(log.mock.calls.some((c) => /no resolvable owner/.test(String(c[0])))).toBe(true);
  });

  it('swallows a chain failure (never rejects the tick)', async () => {
    mockStartEpicChain.mockRejectedValueOnce(new Error('boom'));
    const stmts = makeStmts();
    const log = vi.fn();
    await expect(
      runScheduledEpicStart('proj-1', 'epic-1', {
        getProjects: () => [],
        stmts: stmts as never,
        log,
      }),
    ).resolves.toBeUndefined();
    expect(log.mock.calls.some((c) => /start failed: boom/.test(String(c[0])))).toBe(true);
  });
});

describe('initEpicStartSchedules — registration', () => {
  it('registers a node-cron task per enabled scheduled epic', () => {
    // Type the params so `mock.calls[0][0]` (the cron expression) is indexable —
    // a bare `vi.fn(() => …)` infers a zero-arg tuple and TS rejects `[0][0]`.
    const scheduleFn = vi.fn((..._args: unknown[]) => ({ stop: vi.fn() }));
    initEpicStartSchedules({
      getProjects: () => [PROJECT],
      stmts: makeStmts() as never,
      scheduleFn: scheduleFn as never,
    });
    expect(scheduleFn).toHaveBeenCalledTimes(1);
    expect(scheduleFn.mock.calls[0][0]).toBe('0 9 * * 1');
    expect(getRegisteredEpicStartScheduleIds()).toEqual(['proj-1:epic-1']);
  });

  it('keys schedules by project so a colliding epic id across projects does not evict', () => {
    // Two projects, each with an epic whose id is the SAME ('epic-1'). Keying by
    // bare epic id would let the second registration stop/replace the first.
    const projA = { id: 'proj-a', name: 'A' } as unknown as Project;
    const projB = { id: 'proj-b', name: 'B' } as unknown as Project;
    // getOrCreateBoard yields a distinct board per project.
    mockGetOrCreateBoard.mockImplementation((_stmts: unknown, pid: string) => ({
      board: { id: `board-${pid}` },
    }));
    const rowByProject: Record<string, KanbanEpicRow> = {
      'proj-a': makeEpic({ id: 'epic-1', board_id: 'board-proj-a' }),
      'proj-b': makeEpic({ id: 'epic-1', board_id: 'board-proj-b' }),
    };
    const scheduleFn = vi.fn(() => ({ stop: vi.fn() }));
    initEpicStartSchedules({
      getProjects: () => [projA, projB],
      // Resolve the right row per board id via getStartScheduledEpicsByBoard.
      stmts: {
        getKanbanEpic: { get: vi.fn(() => undefined) },
        getStartScheduledEpicsByBoard: {
          all: vi.fn((boardId: string) =>
            boardId === 'board-proj-a' ? [rowByProject['proj-a']] : [rowByProject['proj-b']],
          ),
        },
      } as never,
      scheduleFn: scheduleFn as never,
    });
    // Both projects' schedules coexist — neither evicts the other.
    expect(getRegisteredEpicStartScheduleIds().sort()).toEqual(['proj-a:epic-1', 'proj-b:epic-1']);
    expect(scheduleFn).toHaveBeenCalledTimes(2);
  });

  it('is a retained pause: a disabled epic registers nothing', () => {
    epicRow = makeEpic({ scheduled_start_enabled: 0 });
    const scheduleFn = vi.fn(() => ({ stop: vi.fn() }));
    initEpicStartSchedules({
      getProjects: () => [PROJECT],
      stmts: makeStmts() as never,
      scheduleFn: scheduleFn as never,
    });
    expect(scheduleFn).not.toHaveBeenCalled();
    expect(getRegisteredEpicStartScheduleIds()).toEqual([]);
  });
});

describe('refresh / unregister', () => {
  it('refresh stops the task when the epic flips to disabled', () => {
    const stop = vi.fn();
    const scheduleFn = vi.fn(() => ({ stop }));
    const stmts = makeStmts();
    initEpicStartSchedules({
      getProjects: () => [PROJECT],
      stmts: stmts as never,
      scheduleFn: scheduleFn as never,
    });
    expect(getRegisteredEpicStartScheduleIds()).toEqual(['proj-1:epic-1']);

    epicRow = makeEpic({ scheduled_start_enabled: 0 });
    refreshEpicStartScheduleRegistration('proj-1', 'epic-1');
    expect(stop).toHaveBeenCalled();
    expect(getRegisteredEpicStartScheduleIds()).toEqual([]);
  });

  it('unregister stops and drops the task', () => {
    const stop = vi.fn();
    const scheduleFn = vi.fn(() => ({ stop }));
    initEpicStartSchedules({
      getProjects: () => [PROJECT],
      stmts: makeStmts() as never,
      scheduleFn: scheduleFn as never,
    });
    unregisterEpicStartSchedule('proj-1', 'epic-1');
    expect(stop).toHaveBeenCalled();
    expect(getRegisteredEpicStartScheduleIds()).toEqual([]);
  });
});
