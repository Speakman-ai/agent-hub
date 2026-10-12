import { describe, expect, it, vi } from 'vitest';
import { restoreCardAfterFailedAssign } from './kanban-assign-restore.js';
import { recomputeEpicState } from './epic-state.js';

vi.mock('./epic-state.js', () => ({ recomputeEpicState: vi.fn() }));
import type { KanbanCardRow } from './types.js';

const before = {
  id: 'card-1',
  column_id: 'col-todo',
  position: 3,
  title: 'T',
  description: 'D',
  priority: 'high',
  assignee: null,
  labels: null,
  session_id: 'old-session',
  github_issue_url: null,
  pr_url: null,
  epic_id: null,
  phase_id: null,
  assign_model: null,
  assign_engine: null,
  pr_base_branch: null,
} as unknown as KanbanCardRow;

function makeStmts(current: Partial<KanbanCardRow> | undefined) {
  return {
    getKanbanCard: { get: vi.fn(() => (current ? { ...before, ...current } : undefined)) },
    updateKanbanCard: { run: vi.fn() },
    moveKanbanCard: { run: vi.fn() },
    createKanbanCardComment: { run: vi.fn() },
  };
}

describe('restoreCardAfterFailedAssign', () => {
  it('puts back the previous column, session, and assignee with a comment', () => {
    const stmts = makeStmts({
      column_id: 'col-prog',
      session_id: 'new-session',
      assignee: 'Dev',
      assign_model: 'm',
    });
    const broadcast = vi.fn();
    const ok = restoreCardAfterFailedAssign(stmts as never, broadcast, {
      before,
      sessionId: 'new-session',
      assignedColumnId: 'col-prog',
      projectId: 'p',
      reason: 'Cannot spawn cursor-agent: no acting user.',
    });
    expect(ok).toBe(true);
    const args = stmts.updateKanbanCard.run.mock.calls[0];
    expect(args[3]).toBeNull(); // assignee
    expect(args[5]).toBe('old-session');
    expect(args[10]).toBeNull(); // assign_model
    expect(args[13]).toBe('card-1');
    expect(stmts.moveKanbanCard.run).toHaveBeenCalledWith('col-todo', 3, 'card-1');
    expect(stmts.createKanbanCardComment.run.mock.calls[0][3]).toMatch(
      /Assignment undone: session new-sess.*no acting user/,
    );
    expect(broadcast).toHaveBeenCalledWith({ type: 'kanban_update', projectId: 'p' });
  });

  it('leaves the card alone once something else re-linked it', () => {
    const stmts = makeStmts({ session_id: 'someone-else' });
    const ok = restoreCardAfterFailedAssign(stmts as never, vi.fn(), {
      before,
      sessionId: 'new-session',
      assignedColumnId: 'col-prog',
      projectId: 'p',
      reason: 'x',
    });
    expect(ok).toBe(false);
    expect(stmts.updateKanbanCard.run).not.toHaveBeenCalled();
    expect(stmts.moveKanbanCard.run).not.toHaveBeenCalled();
  });

  it('keeps a manual column move made while the start was pending', () => {
    const stmts = makeStmts({
      column_id: 'col-review',
      session_id: 'new-session',
      assignee: 'Dev',
    });
    const ok = restoreCardAfterFailedAssign(stmts as never, vi.fn(), {
      before,
      sessionId: 'new-session',
      assignedColumnId: 'col-prog',
      projectId: 'p',
      reason: 'boom',
    });
    expect(ok).toBe(true);
    expect(stmts.moveKanbanCard.run).not.toHaveBeenCalled();
    expect(stmts.updateKanbanCard.run.mock.calls[0][5]).toBe('old-session');
  });

  it('recomputes the epic after moving the card back', () => {
    vi.mocked(recomputeEpicState).mockClear();
    const stmts = makeStmts({
      column_id: 'col-prog',
      session_id: 'new-session',
      epic_id: 'epic-1',
    });
    restoreCardAfterFailedAssign(stmts as never, vi.fn(), {
      before: { ...before, epic_id: 'epic-1' } as KanbanCardRow,
      sessionId: 'new-session',
      assignedColumnId: 'col-prog',
      projectId: 'p',
      reason: 'boom',
    });
    expect(stmts.moveKanbanCard.run).toHaveBeenCalledWith('col-todo', 3, 'card-1');
    expect(recomputeEpicState).toHaveBeenCalledWith(stmts, 'epic-1');
  });
});
