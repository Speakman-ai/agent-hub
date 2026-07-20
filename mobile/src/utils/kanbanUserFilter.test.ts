import { describe, it, expect } from 'vitest';
import {
  usernameForUserId,
  epicMatchesUserFilter,
  cardMatchesUserFilter,
  collectAssignedUserIds,
} from './kanbanUserFilter';

const users = [
  { id: 'u1', username: 'ryan' },
  { id: 'u2', username: 'alex' },
];

describe('kanbanUserFilter (mobile)', () => {
  it('resolves a username for a user id', () => {
    expect(usernameForUserId(users, 'u2')).toBe('alex');
    expect(usernameForUserId(users, 'missing')).toBe(null);
    expect(usernameForUserId(users, null)).toBe(null);
  });

  it('matches every row when no users are selected', () => {
    expect(epicMatchesUserFilter({ assigned_user_id: 'u1' }, new Set())).toBe(true);
    expect(cardMatchesUserFilter({ assigned_user_id: null }, new Set())).toBe(true);
  });

  it('excludes unassigned rows once a user is selected', () => {
    const selected = new Set(['u1']);
    expect(epicMatchesUserFilter({ assigned_user_id: 'u1' }, selected)).toBe(true);
    expect(epicMatchesUserFilter({ assigned_user_id: 'u2' }, selected)).toBe(false);
    expect(epicMatchesUserFilter({ assigned_user_id: null }, selected)).toBe(false);
  });

  it('collects the distinct assigned user ids', () => {
    expect(
      collectAssignedUserIds([
        { assigned_user_id: 'u1' },
        { assigned_user_id: 'u1' },
        { assigned_user_id: 'u2' },
        { assigned_user_id: null },
      ]),
    ).toEqual(['u1', 'u2']);
  });
});
