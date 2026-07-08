import { describe, it, expect } from 'vitest';
import {
  moveTodoId,
  splitTodos,
  sortOpenTodos,
  priorityRank,
  comparePriority,
  todoDoDate,
  timeWindowLabel,
  todoLinkLabel,
  dueState,
  dueLabel,
  dateInputToIso,
  isoToDateInput,
  type TodoLike,
} from './todos';

const mk = (over: Partial<TodoLike> & { id: string }): TodoLike => ({
  status: 'open',
  dueAt: null,
  position: 0,
  ...over,
});

describe('moveTodoId', () => {
  it('moves an id up one slot', () => {
    expect(moveTodoId(['a', 'b', 'c'], 'b', 'up')).toEqual(['b', 'a', 'c']);
  });

  it('moves an id down one slot', () => {
    expect(moveTodoId(['a', 'b', 'c'], 'b', 'down')).toEqual(['a', 'c', 'b']);
  });

  it('returns the original order when already at the top and moving up', () => {
    const ids = ['a', 'b', 'c'];
    expect(moveTodoId(ids, 'a', 'up')).toBe(ids);
  });

  it('returns the original order when already at the bottom and moving down', () => {
    const ids = ['a', 'b', 'c'];
    expect(moveTodoId(ids, 'c', 'down')).toBe(ids);
  });

  it('returns the original order for an unknown id', () => {
    const ids = ['a', 'b'];
    expect(moveTodoId(ids, 'z', 'up')).toBe(ids);
  });

  it('does not mutate the input array', () => {
    const ids = ['a', 'b', 'c'];
    moveTodoId(ids, 'b', 'up');
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});

describe('splitTodos', () => {
  it('separates open and done, preserving order within each bucket', () => {
    const todos = [
      mk({ id: '1', status: 'open' }),
      mk({ id: '2', status: 'done' }),
      mk({ id: '3', status: 'open' }),
      mk({ id: '4', status: 'done' }),
    ];
    const { open, done } = splitTodos(todos);
    expect(open.map((t) => t.id)).toEqual(['1', '3']);
    expect(done.map((t) => t.id)).toEqual(['2', '4']);
  });
});

describe('priorityRank / comparePriority / sortOpenTodos', () => {
  it('ranks urgent highest and low lowest', () => {
    expect(priorityRank('urgent')).toBeLessThan(priorityRank('high'));
    expect(priorityRank('high')).toBeLessThan(priorityRank('medium'));
    expect(priorityRank('medium')).toBeLessThan(priorityRank('low'));
  });

  it('treats an unset/unknown priority as medium', () => {
    expect(priorityRank(null)).toBe(priorityRank('medium'));
    expect(priorityRank(undefined)).toBe(priorityRank('medium'));
    expect(priorityRank('bogus' as any)).toBe(priorityRank('medium'));
  });

  it('sorts open todos most-urgent first, breaking ties by position', () => {
    const todos = [
      mk({ id: 'lo', priority: 'low', position: 0 }),
      mk({ id: 'ur', priority: 'urgent', position: 5 }),
      mk({ id: 'me2', priority: 'medium', position: 2 }),
      mk({ id: 'me1', priority: 'medium', position: 1 }),
    ];
    expect(sortOpenTodos(todos).map((t) => t.id)).toEqual(['ur', 'me1', 'me2', 'lo']);
  });

  it('does not mutate the input array', () => {
    const todos = [mk({ id: 'a', priority: 'low' }), mk({ id: 'b', priority: 'urgent' })];
    sortOpenTodos(todos);
    expect(todos.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('comparePriority returns a stable numeric ordering', () => {
    const a = mk({ id: 'a', priority: 'high', position: 3 });
    const b = mk({ id: 'b', priority: 'high', position: 1 });
    expect(comparePriority(a, b)).toBeGreaterThan(0);
    expect(comparePriority(b, a)).toBeLessThan(0);
  });
});

describe('todoDoDate', () => {
  it('prefers doDate over the deprecated dueAt', () => {
    expect(todoDoDate({ doDate: '2026-07-12T00:00:00Z', dueAt: '2026-01-01T00:00:00Z' })).toBe(
      '2026-07-12T00:00:00Z',
    );
  });

  it('falls back to dueAt for legacy rows without a doDate', () => {
    expect(todoDoDate({ doDate: null, dueAt: '2026-01-01T00:00:00Z' })).toBe(
      '2026-01-01T00:00:00Z',
    );
  });

  it('returns null when neither is set', () => {
    expect(todoDoDate({ doDate: null, dueAt: null })).toBeNull();
    expect(todoDoDate({})).toBeNull();
  });
});

describe('timeWindowLabel', () => {
  it('renders a start–end range when both bounds are set', () => {
    const label = timeWindowLabel('2026-07-12T14:00:00Z', '2026-07-12T15:30:00Z');
    expect(label).toMatch(/–/);
  });

  it('renders a single time when only one bound is set', () => {
    expect(timeWindowLabel('2026-07-12T14:00:00Z', null)).not.toMatch(/–/);
    expect(timeWindowLabel('2026-07-12T14:00:00Z', null)).not.toBe('');
    expect(timeWindowLabel(null, '2026-07-12T15:30:00Z')).not.toBe('');
  });

  it('is empty when neither bound is set or a value is invalid', () => {
    expect(timeWindowLabel(null, null)).toBe('');
    expect(timeWindowLabel('garbage', null)).toBe('');
  });
});

describe('todoLinkLabel', () => {
  it('maps each polymorphic link type to a label', () => {
    expect(todoLinkLabel({ linkedType: 'card' })).toBe('Ticket');
    expect(todoLinkLabel({ linkedType: 'epic' })).toBe('Epic');
    expect(todoLinkLabel({ linkedType: 'session' })).toBe('Session');
  });

  it('falls back to Ticket for a legacy linkedCardId', () => {
    expect(todoLinkLabel({ linkedType: null, linkedCardId: 'k1' })).toBe('Ticket');
  });

  it('is empty when unlinked', () => {
    expect(todoLinkLabel({})).toBe('');
    expect(todoLinkLabel({ linkedType: null, linkedCardId: null })).toBe('');
  });
});

describe('dueState / dueLabel', () => {
  const now = new Date('2026-07-07T12:00:00');

  it('classifies past dates as overdue', () => {
    expect(dueState('2026-07-06T09:00:00', now)).toBe('overdue');
    expect(dueLabel('2026-07-06T09:00:00', now)).toMatch(/^Overdue/);
  });

  it('classifies same-day (any time) as today', () => {
    expect(dueState('2026-07-07T23:00:00', now)).toBe('today');
    expect(dueLabel('2026-07-07T23:00:00', now)).toBe('Today');
  });

  it('classifies the next day as tomorrow', () => {
    expect(dueState('2026-07-08T00:30:00', now)).toBe('tomorrow');
    expect(dueLabel('2026-07-08T00:30:00', now)).toBe('Tomorrow');
  });

  it('classifies further-out dates as upcoming with a short date label', () => {
    expect(dueState('2026-07-15T00:00:00', now)).toBe('upcoming');
    expect(dueLabel('2026-07-15T00:00:00', now)).not.toMatch(/Overdue|Today|Tomorrow/);
  });

  it('returns none/empty for missing or invalid dates', () => {
    expect(dueState(null, now)).toBe('none');
    expect(dueState('not-a-date', now)).toBe('none');
    expect(dueLabel(null, now)).toBe('');
  });
});

describe('date <-> input conversions', () => {
  it('round-trips a date-input value through ISO', () => {
    const iso = dateInputToIso('2026-07-12');
    expect(iso).not.toBeNull();
    expect(isoToDateInput(iso)).toBe('2026-07-12');
  });

  it('treats an empty input as clearing the due date', () => {
    expect(dateInputToIso('')).toBeNull();
    expect(dateInputToIso('   ')).toBeNull();
  });

  it('returns empty for a null/invalid ISO', () => {
    expect(isoToDateInput(null)).toBe('');
    expect(isoToDateInput('garbage')).toBe('');
  });
});
