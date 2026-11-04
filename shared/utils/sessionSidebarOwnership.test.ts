import { describe, expect, it } from 'vitest';
import { isSessionVisibleInOwnSidebar } from './sessionSidebarOwnership';

describe('isSessionVisibleInOwnSidebar', () => {
  it('shows the signed-in user their own session', () => {
    expect(isSessionVisibleInOwnSidebar({ owner_user_id: 'me' }, 'me')).toBe(true);
  });

  it("hides another user's session", () => {
    expect(isSessionVisibleInOwnSidebar({ owner_user_id: 'someone-else' }, 'me')).toBe(false);
  });

  it('hides unowned sessions from a signed-in user, matching the list route', () => {
    expect(isSessionVisibleInOwnSidebar({ owner_user_id: null }, 'me')).toBe(false);
    expect(isSessionVisibleInOwnSidebar({}, 'me')).toBe(false);
  });

  it('shows everything when there is no signed-in user id (local bundle)', () => {
    expect(isSessionVisibleInOwnSidebar({ owner_user_id: 'someone-else' }, null)).toBe(true);
    expect(isSessionVisibleInOwnSidebar({ owner_user_id: null }, undefined)).toBe(true);
  });

  it('rejects a missing row', () => {
    expect(isSessionVisibleInOwnSidebar(null, 'me')).toBe(false);
  });
});
