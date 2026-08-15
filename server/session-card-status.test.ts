import { describe, expect, it, vi } from 'vitest';
import { syncLinkedCardToSessionStatus } from './session-card-status.js';
import type { KanbanCardRow, KanbanColumnRow, Stmts } from './types.js';

function makeColumn(id: string, name: string, position: number): KanbanColumnRow {
  return {
    id,
    board_id: 'board-1',
    name,
    position,
    color: null,
    created_at: '2026-01-01T00:00:00Z',
  };
}

function makeCard(overrides: Partial<KanbanCardRow> = {}): KanbanCardRow {
  return {
    id: 'card-1',
    board_id: 'board-1',
    column_id: 'in-progress',
    title: 'Linked ticket',
    description: null,
    priority: 'medium',
    assignee: null,
    labels: null,
    session_id: 'session-1',
    github_issue_url: null,
    pr_url: null,
    review_status: null,
    created_by: null,
    short_id: 1,
    position: 0,
    epic_id: null,
    documented: 0,
    dispatched_by_autonomous: 0,
    orphaned_at: null,
    ...overrides,
  } as KanbanCardRow;
}

function makeDeps(card: KanbanCardRow, columns: KanbanColumnRow[]) {
  const move = vi.fn();
  const clearOrphan = vi.fn();
  const broadcast = vi.fn();
  const stmts = {
    getKanbanCardBySession: { get: vi.fn(() => card) },
    getKanbanBoardById: { get: vi.fn(() => ({ id: 'board-1', project_id: 'project-1' })) },
    getKanbanColumns: { all: vi.fn(() => columns) },
    moveKanbanCard: { run: move },
    clearKanbanCardOrphaned: { run: clearOrphan },
  } as unknown as Stmts;
  return { deps: { stmts, broadcast }, move, clearOrphan, broadcast };
}

describe('syncLinkedCardToSessionStatus', () => {
  it('preserves a card already in a Shipped lane when its session is archived', () => {
    const shipped = makeColumn('shipped', 'Shipped', 2);
    const done = makeColumn('done', 'Done', 1);
    const { deps, move, broadcast } = makeDeps(makeCard({ column_id: shipped.id }), [
      done,
      shipped,
    ]);

    const result = syncLinkedCardToSessionStatus(deps, 'session-1', 'closed');

    expect(result).toMatchObject({ action: 'keep', reason: 'already-closed' });
    expect(move).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('clears a legacy orphan marker even when the board has no In Progress column', () => {
    const done = makeColumn('done', 'Done', 1);
    const { deps, move, clearOrphan, broadcast } = makeDeps(
      makeCard({ column_id: done.id, orphaned_at: '2026-08-01T00:00:00Z' }),
      [done],
    );

    const result = syncLinkedCardToSessionStatus(deps, 'session-1', 'in-progress');

    expect(result).toMatchObject({
      action: 'clear-orphan',
      reason: 'orphan-cleared:no-in-progress-column',
    });
    expect(clearOrphan).toHaveBeenCalledWith('card-1');
    expect(move).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith({ type: 'kanban_update', projectId: 'project-1' });
  });
});
