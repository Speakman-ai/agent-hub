import { describe, expect, it } from 'vitest';
import { findSlashQuery, insertSlashCommand } from './slashQuery';

describe('findSlashQuery', () => {
  it('finds a command at the start of the text', () => {
    expect(findSlashQuery('/dep', 4)).toEqual({ start: 0, end: 4, query: 'dep' });
  });

  it('finds a command at the start of a later line', () => {
    expect(findSlashQuery('hi\n/k', 5)).toEqual({ start: 3, end: 5, query: 'k' });
  });

  it('reads only the text before the caret', () => {
    expect(findSlashQuery('/kanban tail', 3)).toEqual({ start: 0, end: 3, query: 'ka' });
  });

  it('ignores a slash mid-line, after a space, or out-of-range carets', () => {
    expect(findSlashQuery('a/b', 3)).toBeNull();
    expect(findSlashQuery('/kanban x', 9)).toBeNull();
    expect(findSlashQuery('/k', 5)).toBeNull();
  });
});

describe('insertSlashCommand', () => {
  it('replaces the query and puts the caret after the inserted command', () => {
    const text = 'hi\n/ka tail';
    const slash = findSlashQuery(text, 6)!;
    expect(insertSlashCommand(text, slash, 'kanban')).toEqual({
      text: 'hi\n/kanban  tail',
      caret: 'hi\n/kanban '.length,
    });
  });
});
