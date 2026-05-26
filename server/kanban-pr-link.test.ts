import { describe, it, expect, vi } from 'vitest';
import type { KanbanCardRow, KanbanColumnRow } from './types.js';
import {
  findKanbanCardByPrTitle,
  findKanbanCardForIncomingPr,
  linkKanbanCardPrUrl,
  SESSION_BRANCH_REF_RE,
} from './kanban-pr-link.js';

describe('SESSION_BRANCH_REF_RE', () => {
  it('matches session id suffix inside agent-hub branch names', () => {
    expect('agent-hub/agent-hub/session-deadbeef'.match(SESSION_BRANCH_REF_RE)?.[1]).toBe(
      'deadbeef',
    );
  });
});

describe('findKanbanCardByPrTitle', () => {
  const cols: KanbanColumnRow[] = [
    { id: 'col-todo', name: 'To Do', board_id: 'b1', position: 0 } as KanbanColumnRow,
    { id: 'col-done', name: 'Done', board_id: 'b1', position: 3 } as KanbanColumnRow,
  ];

  it('finds an open card with matching title and no pr_url', () => {
    const card = {
      id: 'c1',
      column_id: 'col-todo',
      title: 'Fix CI failure',
      pr_url: null,
    } as KanbanCardRow;
    const stmts = {
      getKanbanCards: { all: vi.fn(() => [card]) },
    };

    expect(
      findKanbanCardByPrTitle(
        stmts as never,
        'b1',
        'https://github.com/o/r/pull/101',
        'Fix CI failure',
        cols,
      )?.id,
    ).toBe('c1');
  });

  it('does not return a Done card with the same title', () => {
    const card = {
      id: 'c-done',
      column_id: 'col-done',
      title: 'Fix CI failure',
      pr_url: 'https://github.com/o/r/pull/100',
    } as KanbanCardRow;
    const stmts = {
      getKanbanCards: { all: vi.fn(() => [card]) },
    };

    expect(
      findKanbanCardByPrTitle(
        stmts as never,
        'b1',
        'https://github.com/o/r/pull/101',
        'Fix CI failure',
        cols,
      ),
    ).toBeUndefined();
  });

  it('does not return a card already bound to a different PR URL', () => {
    const card = {
      id: 'c1',
      column_id: 'col-todo',
      title: 'Fix CI failure',
      pr_url: 'https://github.com/o/r/pull/100',
    } as KanbanCardRow;
    const stmts = {
      getKanbanCards: { all: vi.fn(() => [card]) },
    };

    expect(
      findKanbanCardByPrTitle(
        stmts as never,
        'b1',
        'https://github.com/o/r/pull/101',
        'Fix CI failure',
        cols,
      ),
    ).toBeUndefined();
  });
});

describe('findKanbanCardForIncomingPr', () => {
  const cols: KanbanColumnRow[] = [
    { id: 'col-todo', name: 'To Do', board_id: 'b1', position: 0 } as KanbanColumnRow,
  ];

  it('prefers branch session id over title when PR title differs from card title', () => {
    const sessionId = 'abcdef12-0000-4000-8000-000000000001';
    const card = {
      id: 'c1',
      column_id: 'col-todo',
      title: 'Kanban card title from ticket',
      session_id: sessionId,
      pr_url: null,
    } as KanbanCardRow;
    const stmts = {
      getKanbanCardByPrUrl: { get: vi.fn(() => undefined) },
      getKanbanCards: { all: vi.fn(() => [card]) },
      getSessionIdsByWorktreeBranch: { all: vi.fn(() => []) },
    };

    const { card: found, path } = findKanbanCardForIncomingPr(stmts as never, 'b1', {
      prUrl: 'https://github.com/o/r/pull/55',
      headRef: 'agent-hub/agent-hub/session-abcdef12',
      prTitle: 'feat: commit subject used as PR title',
      cols,
      prNumber: 55,
    });

    expect(path).toBe('branch_session_id');
    expect(found?.id).toBe('c1');
  });

  it('resolves via worktree_branch when head ref has no session- prefix', () => {
    const sessionId = '11111111-2222-4333-8444-555555555555';
    const card = {
      id: 'c2',
      column_id: 'col-todo',
      title: 'Work tracked on feature branch',
      session_id: sessionId,
      pr_url: null,
    } as KanbanCardRow;
    const stmts = {
      getKanbanCardByPrUrl: { get: vi.fn(() => undefined) },
      getKanbanCards: { all: vi.fn(() => []) },
      getSessionIdsByWorktreeBranch: { all: vi.fn(() => [{ id: sessionId }]) },
      getKanbanCardBySession: { get: vi.fn(() => card) },
    };

    const { card: found, path } = findKanbanCardForIncomingPr(stmts as never, 'b1', {
      prUrl: 'https://github.com/o/r/pull/56',
      headRef: 'feature/custom-branch-name',
      prTitle: 'unrelated pr title',
      cols,
    });

    expect(path).toBe('branch_worktree');
    expect(found?.id).toBe('c2');
  });
});

describe('linkKanbanCardPrUrl', () => {
  it('persists pr_url and broadcasts kanban_update', () => {
    const setCardPrUrl = { run: vi.fn() };
    const broadcast = vi.fn();
    const card = {
      id: 'c1',
      title: 'My card',
      pr_url: null,
    } as KanbanCardRow;

    const linked = linkKanbanCardPrUrl(
      { setCardPrUrl } as never,
      broadcast,
      'proj-1',
      card,
      'https://github.com/o/r/pull/9',
      'branch_session_id',
      9,
    );

    expect(linked).toBe(true);
    expect(setCardPrUrl.run).toHaveBeenCalledWith('https://github.com/o/r/pull/9', 'c1');
    expect(broadcast).toHaveBeenCalledWith({ type: 'kanban_update', projectId: 'proj-1' });
  });
});
