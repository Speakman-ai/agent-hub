import { describe, it, expect } from 'vitest';
import { selectVisibleCardsByColumn, cardMatchesSearch } from './kanbanBoardCards';

const columns = [{ id: 'todo' }, { id: 'wip' }, { id: 'done' }];

function card(over: Record<string, any>) {
  return {
    id: over.id,
    column_id: over.column_id,
    position: over.position ?? 0,
    title: over.title ?? '',
    description: over.description ?? '',
    labels: over.labels ?? '',
    assignee: over.assignee ?? '',
    epic_id: over.epic_id ?? null,
    assigned_user_id: over.assigned_user_id ?? null,
    ...over,
  };
}

describe('selectVisibleCardsByColumn', () => {
  it('groups cards by column and sorts each column by position', () => {
    const cards = [
      card({ id: 'a', column_id: 'todo', position: 2 }),
      card({ id: 'b', column_id: 'todo', position: 1 }),
      card({ id: 'c', column_id: 'wip', position: 0 }),
    ];
    const byCol = selectVisibleCardsByColumn(cards, columns);
    expect(byCol.get('todo')!.map((c) => c.id)).toEqual(['b', 'a']);
    expect(byCol.get('wip')!.map((c) => c.id)).toEqual(['c']);
    expect(byCol.get('done')).toEqual([]);
  });

  it('includes an entry for every rendered column, even empty ones', () => {
    const byCol = selectVisibleCardsByColumn([], columns);
    expect([...byCol.keys()].sort()).toEqual(['done', 'todo', 'wip']);
  });

  it('drops cards whose column is not being rendered', () => {
    const cards = [card({ id: 'a', column_id: 'archived', position: 0 })];
    const byCol = selectVisibleCardsByColumn(cards, columns);
    expect([...byCol.values()].every((list) => list.length === 0)).toBe(true);
  });

  it('applies the search filter across title, description, labels, and assignee', () => {
    const cards = [
      card({ id: 'title', column_id: 'todo', title: 'Fix the widget' }),
      card({ id: 'desc', column_id: 'todo', description: 'about the WIDGET internals' }),
      card({ id: 'label', column_id: 'todo', labels: 'widget,ui' }),
      card({ id: 'assignee', column_id: 'todo', assignee: 'widget-bot' }),
      card({ id: 'nomatch', column_id: 'todo', title: 'unrelated' }),
    ];
    const byCol = selectVisibleCardsByColumn(cards, columns, { searchQuery: 'widget' });
    expect(
      byCol
        .get('todo')!
        .map((c) => c.id)
        .sort(),
    ).toEqual(['assignee', 'desc', 'label', 'title']);
  });

  it('is a single pass: total grouped cards never exceed the input size', () => {
    const cards = Array.from({ length: 100 }, (_, i) =>
      card({ id: `c${i}`, column_id: columns[i % 3]!.id, position: i }),
    );
    const byCol = selectVisibleCardsByColumn(cards, columns);
    const total = [...byCol.values()].reduce((n, list) => n + list.length, 0);
    expect(total).toBe(100);
  });
});

describe('cardMatchesSearch', () => {
  it('matches everything on an empty query', () => {
    expect(cardMatchesSearch(card({ id: 'x', column_id: 'todo', title: 'zzz' }), '')).toBe(true);
  });

  it('is case-insensitive and tolerates missing fields', () => {
    const c = { title: 'Hello World' };
    expect(cardMatchesSearch(c, 'world')).toBe(true);
    expect(cardMatchesSearch(c, 'nope')).toBe(false);
  });
});
