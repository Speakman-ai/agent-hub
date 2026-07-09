import { describe, it, expect } from 'vitest';
import { pickTodoColumn } from './pickTodoColumn';

describe('pickTodoColumn', () => {
  it('returns the column named "To Do" (case/space-insensitive)', () => {
    const cols = [
      { id: 'a', name: 'In Progress' },
      { id: 'b', name: '  to do ' },
      { id: 'c', name: 'Done' },
    ];
    expect(pickTodoColumn(cols)?.id).toBe('b');
  });

  it('falls back to the first column when there is no To Do column', () => {
    const cols = [
      { id: 'x', name: 'Backlog' },
      { id: 'y', name: 'Shipping' },
    ];
    expect(pickTodoColumn(cols)?.id).toBe('x');
  });

  it('returns null for empty / nullish column lists', () => {
    expect(pickTodoColumn([])).toBeNull();
    expect(pickTodoColumn(null)).toBeNull();
    expect(pickTodoColumn(undefined)).toBeNull();
  });

  it('tolerates columns with a missing name', () => {
    const cols = [{ id: 'n' }, { id: 'm', name: 'To Do' }];
    expect(pickTodoColumn(cols)?.id).toBe('m');
  });
});
