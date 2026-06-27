import { describe, it, expect } from 'vitest';
import { cardMatchesUserFilter, epicMatchesUserFilter } from './kanbanUserFilter';

describe('kanbanUserFilter', () => {
  it('matches cards by assigned user with OR semantics', () => {
    const selected = new Set(['u1']);
    expect(cardMatchesUserFilter({ assigned_user_id: 'u1' }, selected)).toBe(true);
    expect(cardMatchesUserFilter({ assigned_user_id: 'u2' }, selected)).toBe(false);
    expect(cardMatchesUserFilter({ assigned_user_id: null }, selected)).toBe(false);
    expect(cardMatchesUserFilter({ assigned_user_id: 'u1' }, new Set())).toBe(true);
  });

  it('matches epics by assigned user', () => {
    const selected = new Set(['u2']);
    expect(epicMatchesUserFilter({ assigned_user_id: 'u2' }, selected)).toBe(true);
    expect(epicMatchesUserFilter({ assigned_user_id: 'u1' }, selected)).toBe(false);
  });
});
