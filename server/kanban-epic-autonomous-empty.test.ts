import { describe, it, expect, vi } from 'vitest';
import { disableAutonomousForEmptyEpic } from './kanban-epic-autonomous-empty.js';
import type { KanbanEpicRow } from './types.js';

function makeEpic(overrides: Partial<KanbanEpicRow> = {}): KanbanEpicRow {
  return {
    id: 'epic-1',
    board_id: 'board-1',
    name: 'Epic One',
    description: null,
    state: null,
    labels: null,
    color: '#6366F1',
    autonomous: 1,
    autonomous_interval: 5,
    autonomous_max_concurrent: 1,
    autonomous_model: null,
    orchestration_budgets_json: null,
    pr_base_branch: null,
    position: 0,
    created_at: '2026-07-02 00:00:00',
    updated_at: '2026-07-02 00:00:00',
    ...overrides,
  } as KanbanEpicRow;
}

/** Minimal Stmts fake exposing only what the helper touches. */
function makeDeps(epic: KanbanEpicRow | undefined, cards: unknown[]) {
  const updateKanbanEpic = { run: vi.fn() };
  // getKanbanEpic returns the (possibly mutated) epic; after the update we
  // hand back a row reflecting autonomous=0 so the reschedule sees it.
  let current = epic;
  const stmts = {
    getKanbanEpic: {
      get: vi.fn(() => current),
    },
    getKanbanCardsByEpic: {
      all: vi.fn(() => cards),
    },
    updateKanbanEpic: {
      run: vi.fn((...args: unknown[]) => {
        updateKanbanEpic.run(...args);
        if (current) current = { ...current, autonomous: args[3] as number };
      }),
    },
  };
  const broadcast = vi.fn();
  const scheduleAutonomousEpic = vi.fn();
  return {
    deps: { stmts, broadcast, scheduleAutonomousEpic } as never,
    stmts,
    broadcast,
    scheduleAutonomousEpic,
  };
}

describe('disableAutonomousForEmptyEpic', () => {
  it('disarms an autonomous epic that has no cards left', () => {
    const epic = makeEpic({ autonomous: 1 });
    const { deps, stmts, broadcast, scheduleAutonomousEpic } = makeDeps(epic, []);

    const changed = disableAutonomousForEmptyEpic(deps, 'proj', 'epic-1');

    expect(changed).toBe(true);
    // autonomous flag (4th positional arg) written as 0
    expect(stmts.updateKanbanEpic.run).toHaveBeenCalledTimes(1);
    expect((stmts.updateKanbanEpic.run as ReturnType<typeof vi.fn>).mock.calls[0][3]).toBe(0);
    // reschedule stops the cron; UI told to refresh
    expect(scheduleAutonomousEpic).toHaveBeenCalledWith(
      'proj',
      expect.objectContaining({ autonomous: 0 }),
    );
    expect(broadcast).toHaveBeenCalledWith({ type: 'kanban_update', projectId: 'proj' });
  });

  it('leaves an autonomous epic alone while it still has cards', () => {
    const epic = makeEpic({ autonomous: 1 });
    const { deps, stmts, broadcast, scheduleAutonomousEpic } = makeDeps(epic, [{ id: 'c1' }]);

    const changed = disableAutonomousForEmptyEpic(deps, 'proj', 'epic-1');

    expect(changed).toBe(false);
    expect(stmts.updateKanbanEpic.run).not.toHaveBeenCalled();
    expect(scheduleAutonomousEpic).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not touch an epic that is not autonomous', () => {
    const epic = makeEpic({ autonomous: 0 });
    const { deps, stmts, scheduleAutonomousEpic } = makeDeps(epic, []);

    const changed = disableAutonomousForEmptyEpic(deps, 'proj', 'epic-1');

    expect(changed).toBe(false);
    expect(stmts.updateKanbanEpic.run).not.toHaveBeenCalled();
    expect(scheduleAutonomousEpic).not.toHaveBeenCalled();
  });

  it('no-ops on a null epic id', () => {
    const { deps, stmts } = makeDeps(makeEpic(), []);
    expect(disableAutonomousForEmptyEpic(deps, 'proj', null)).toBe(false);
    expect(stmts.getKanbanEpic.get).not.toHaveBeenCalled();
  });

  it('no-ops when the epic no longer exists', () => {
    const { deps, scheduleAutonomousEpic } = makeDeps(undefined, []);
    expect(disableAutonomousForEmptyEpic(deps, 'proj', 'gone')).toBe(false);
    expect(scheduleAutonomousEpic).not.toHaveBeenCalled();
  });
});
