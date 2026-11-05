import { describe, it, expect } from 'vitest';
import {
  applyTodoView,
  DEFAULT_TODO_VIEW,
  isTodoViewActive,
  todoMatchesDate,
  todoMatchesQuery,
  type TodoViewItem,
} from './todoView';

// shared/ has no Node types; reach process.env through globalThis for the TZ override.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } })
  .process.env;

const now = new Date(2026, 10, 5, 12, 0, 0);
const day = (offset: number) => new Date(2026, 10, 5 + offset, 9, 0, 0).toISOString();

const todos: (TodoViewItem & { id: string })[] = [
  {
    id: 'a',
    title: 'Write report',
    notes: 'quarterly numbers',
    priority: 'low',
    doDate: day(3),
    position: 0,
    createdAt: day(-5),
  },
  {
    id: 'b',
    title: 'call dentist',
    priority: 'urgent',
    doDate: day(-1),
    position: 1,
    createdAt: day(-1),
  },
  {
    id: 'c',
    title: 'Buy milk',
    notes: null,
    priority: 'medium',
    doDate: null,
    position: 2,
    createdAt: day(-3),
  },
  {
    id: 'd',
    title: 'Review PR',
    notes: 'auth refactor',
    priority: 'high',
    dueAt: day(0),
    position: 3,
    createdAt: day(-2),
  },
];
const ids = (list: { id: string }[]) => list.map((t) => t.id);

describe('todoView', () => {
  it('default view sorts by urgency then position', () => {
    expect(ids(applyTodoView(todos, DEFAULT_TODO_VIEW, now))).toEqual(['b', 'd', 'c', 'a']);
  });

  it('searches title and notes case-insensitively, all terms required', () => {
    expect(todoMatchesQuery(todos[0], 'QUARTERLY')).toBe(true);
    expect(todoMatchesQuery(todos[0], 'report numbers')).toBe(true);
    expect(todoMatchesQuery(todos[0], 'report milk')).toBe(false);
    expect(ids(applyTodoView(todos, { ...DEFAULT_TODO_VIEW, query: 'auth' }, now))).toEqual(['d']);
  });

  it('filters by urgency, treating unset as medium', () => {
    const list = [...todos, { id: 'e', title: 'x', priority: null, position: 4 }];
    expect(ids(applyTodoView(list, { ...DEFAULT_TODO_VIEW, priority: 'medium' }, now))).toEqual([
      'c',
      'e',
    ]);
  });

  it('filters by date bucket, falling back to dueAt', () => {
    expect(todoMatchesDate(todos[1], 'overdue', now)).toBe(true);
    expect(todoMatchesDate(todos[3], 'today', now)).toBe(true);
    expect(todoMatchesDate(todos[2], 'none', now)).toBe(true);
    expect(ids(applyTodoView(todos, { ...DEFAULT_TODO_VIEW, date: 'week' }, now))).toEqual([
      'd',
      'a',
    ]);
  });

  it('keeps the next-7-days window to seven calendar days across a DST start', () => {
    const prevTz = env.TZ;
    env.TZ = 'America/New_York';
    try {
      // DST starts 2026-03-08, so 2026-03-14 midnight is only 167h after 03-07 midnight.
      const dstNow = new Date(2026, 2, 7, 12, 0, 0);
      const at = (d: number) => ({
        title: 't',
        position: 0,
        doDate: new Date(2026, 2, d).toISOString(),
      });
      expect(todoMatchesDate(at(13), 'week', dstNow)).toBe(true);
      expect(todoMatchesDate(at(14), 'week', dstNow)).toBe(false);
    } finally {
      if (prevTz === undefined) delete env.TZ;
      else env.TZ = prevTz;
    }
  });

  it('sorts by do date with undated last', () => {
    expect(ids(applyTodoView(todos, { ...DEFAULT_TODO_VIEW, sort: 'doDate' }, now))).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
  });

  it('sorts by subject ignoring case, and by newest', () => {
    expect(ids(applyTodoView(todos, { ...DEFAULT_TODO_VIEW, sort: 'title' }, now))).toEqual([
      'c',
      'b',
      'd',
      'a',
    ]);
    expect(ids(applyTodoView(todos, { ...DEFAULT_TODO_VIEW, sort: 'created' }, now))).toEqual([
      'b',
      'd',
      'c',
      'a',
    ]);
  });

  it('reports whether the view departs from the default', () => {
    expect(isTodoViewActive(DEFAULT_TODO_VIEW)).toBe(false);
    expect(isTodoViewActive({ ...DEFAULT_TODO_VIEW, query: '  ' })).toBe(false);
    expect(isTodoViewActive({ ...DEFAULT_TODO_VIEW, sort: 'title' })).toBe(true);
  });
});
