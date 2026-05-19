import { describe, it, expect, vi } from 'vitest';
import type { KanbanCardRow, KanbanColumnRow } from '../types.js';
import { tryLinkKanbanCardByPrTitle } from './webhooks.js';

describe('tryLinkKanbanCardByPrTitle', () => {
  const cols: KanbanColumnRow[] = [
    { id: 'col-todo', name: 'To Do', board_id: 'b1', position: 0 } as KanbanColumnRow,
    { id: 'col-done', name: 'Done', board_id: 'b1', position: 3 } as KanbanColumnRow,
  ];

  it('links when pr_url is unset and title matches', () => {
    const setCardPrUrl = { run: vi.fn() };
    const card = {
      id: 'c1',
      column_id: 'col-todo',
      title: 'Fix CI failure',
      pr_url: null,
    } as KanbanCardRow;
    const stmts = {
      getKanbanCards: { all: vi.fn(() => [card]) },
      setCardPrUrl,
    };

    const linked = tryLinkKanbanCardByPrTitle(
      stmts as never,
      'b1',
      'https://github.com/o/r/pull/101',
      'Fix CI failure',
      cols,
      101,
    );

    expect(linked?.id).toBe('c1');
    expect(setCardPrUrl.run).toHaveBeenCalledWith('https://github.com/o/r/pull/101', 'c1');
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
      setCardPrUrl: { run: vi.fn() },
    };

    const linked = tryLinkKanbanCardByPrTitle(
      stmts as never,
      'b1',
      'https://github.com/o/r/pull/101',
      'Fix CI failure',
      cols,
      101,
    );

    expect(linked).toBeUndefined();
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
      setCardPrUrl: { run: vi.fn() },
    };

    const linked = tryLinkKanbanCardByPrTitle(
      stmts as never,
      'b1',
      'https://github.com/o/r/pull/101',
      'Fix CI failure',
      cols,
      101,
    );

    expect(linked).toBeUndefined();
  });
});
