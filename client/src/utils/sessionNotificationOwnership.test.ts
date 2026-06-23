import { describe, it, expect } from 'vitest';
import { isSessionOwnedByOtherUser } from './sessionNotificationOwnership';

const rec = (id: any) => () => (id === undefined ? null : { user: { id } });

describe('isSessionOwnedByOtherUser', () => {
  it('suppresses when the session is owned by a different signed-in user', () => {
    // The reported bug: Alice (u-alice) gets Kevin's (u-kevin) session toast.
    expect(isSessionOwnedByOtherUser('u-kevin', rec('u-alice'))).toBe(true);
  });

  it('shows when the current user owns the session', () => {
    expect(isSessionOwnedByOtherUser('u-alice', rec('u-alice'))).toBe(false);
  });

  it('shows for unowned (cron / heartbeat / system) sessions', () => {
    expect(isSessionOwnedByOtherUser(null, rec('u-alice'))).toBe(false);
    expect(isSessionOwnedByOtherUser(undefined, rec('u-alice'))).toBe(false);
    expect(isSessionOwnedByOtherUser('', rec('u-alice'))).toBe(false);
  });

  it('shows when the client has no user id (local bundled / legacy token)', () => {
    // No auth record at all (local bundled single-user mode).
    expect(isSessionOwnedByOtherUser('u-kevin', rec(undefined))).toBe(false);
    // Legacy token with a user record but no `id` field.
    expect(isSessionOwnedByOtherUser('u-kevin', () => ({ user: {} }))).toBe(false);
    expect(isSessionOwnedByOtherUser('u-kevin', () => ({ user: { username: 'x' } }))).toBe(false);
  });
});
