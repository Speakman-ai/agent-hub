import { describe, it, expect } from 'vitest';
import { isSystemLockedColumnName } from './kanbanColumns';

describe('isSystemLockedColumnName', () => {
  it('locks the default automation columns', () => {
    expect(isSystemLockedColumnName('To Do')).toBe(true);
    expect(isSystemLockedColumnName('In Progress')).toBe(true);
    expect(isSystemLockedColumnName('Done')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isSystemLockedColumnName('to do')).toBe(true);
    expect(isSystemLockedColumnName('DONE')).toBe(true);
  });

  it('does not lock custom columns', () => {
    expect(isSystemLockedColumnName('QA')).toBe(false);
    expect(isSystemLockedColumnName('Review')).toBe(false);
    expect(isSystemLockedColumnName('Deployed / Done')).toBe(false);
  });
});
