import { describe, it, expect } from 'vitest';
import {
  buildLinkedTodoTarget,
  normalizeTodoPriority,
  summarizeLinkedTodo,
  summarizeLinkedTodos,
  type LinkedTodoInput,
} from './linkedTodos';

function todo(overrides: Partial<LinkedTodoInput> = {}): LinkedTodoInput {
  return {
    id: 't1',
    title: 'Do the thing',
    status: 'open',
    priority: 'high',
    doDate: null,
    dueAt: null,
    ...overrides,
  };
}

describe('buildLinkedTodoTarget', () => {
  it('builds a project-scoped target for a saved card', () => {
    expect(buildLinkedTodoTarget('card', { id: 'card-1' }, 'proj')).toEqual({
      targetType: 'card',
      targetId: 'card-1',
      projectId: 'proj',
    });
  });

  it('builds an epic target', () => {
    expect(buildLinkedTodoTarget('epic', { id: 'epic-9' }, 'proj')).toEqual({
      targetType: 'epic',
      targetId: 'epic-9',
      projectId: 'proj',
    });
  });

  it('returns null for a draft (unsaved) card', () => {
    expect(buildLinkedTodoTarget('card', { id: 'card-1', __draft: true }, 'proj')).toBeNull();
  });

  it('returns null when the entity is missing / has no id', () => {
    expect(buildLinkedTodoTarget('card', null, 'proj')).toBeNull();
    expect(buildLinkedTodoTarget('card', {}, 'proj')).toBeNull();
    expect(buildLinkedTodoTarget('card', { id: '  ' }, 'proj')).toBeNull();
  });

  it('returns null when the project id is missing (card/epic links are project-scoped)', () => {
    expect(buildLinkedTodoTarget('card', { id: 'card-1' }, '')).toBeNull();
    expect(buildLinkedTodoTarget('card', { id: 'card-1' }, null)).toBeNull();
    expect(buildLinkedTodoTarget('epic', { id: 'epic-1' }, undefined)).toBeNull();
  });

  it('trims the entity id and project id', () => {
    expect(buildLinkedTodoTarget('card', { id: ' card-1 ' }, ' proj ')).toEqual({
      targetType: 'card',
      targetId: 'card-1',
      projectId: 'proj',
    });
  });
});

describe('normalizeTodoPriority', () => {
  it('passes through valid priorities', () => {
    expect(normalizeTodoPriority('urgent')).toBe('urgent');
    expect(normalizeTodoPriority('low')).toBe('low');
  });

  it('lowercases before matching', () => {
    expect(normalizeTodoPriority('HIGH')).toBe('high');
  });

  it('defaults unknown / null to medium', () => {
    expect(normalizeTodoPriority(null)).toBe('medium');
    expect(normalizeTodoPriority(undefined)).toBe('medium');
    expect(normalizeTodoPriority('bogus')).toBe('medium');
  });
});

describe('summarizeLinkedTodo', () => {
  it('shapes an open todo with its do-date', () => {
    expect(summarizeLinkedTodo(todo({ doDate: '2026-07-10T00:00:00Z' }))).toEqual({
      id: 't1',
      title: 'Do the thing',
      done: false,
      priority: 'high',
      doDate: '2026-07-10T00:00:00Z',
    });
  });

  it('marks done todos and normalizes an unknown priority', () => {
    const s = summarizeLinkedTodo(todo({ status: 'done', priority: null }));
    expect(s.done).toBe(true);
    expect(s.priority).toBe('medium');
  });

  it('falls back to the deprecated dueAt when doDate is unset', () => {
    const s = summarizeLinkedTodo(todo({ doDate: null, dueAt: '2026-07-12T00:00:00Z' }));
    expect(s.doDate).toBe('2026-07-12T00:00:00Z');
  });
});

describe('summarizeLinkedTodos', () => {
  it('floats open todos above done ones, preserving incoming order within each bucket', () => {
    const list = summarizeLinkedTodos([
      todo({ id: 'a', status: 'done' }),
      todo({ id: 'b', status: 'open' }),
      todo({ id: 'c', status: 'done' }),
      todo({ id: 'd', status: 'open' }),
    ]);
    expect(list.map((t) => t.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('returns an empty list unchanged', () => {
    expect(summarizeLinkedTodos([])).toEqual([]);
  });
});
