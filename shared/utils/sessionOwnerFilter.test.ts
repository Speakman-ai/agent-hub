import { describe, it, expect } from 'vitest';
import {
  ALL_OWNERS,
  ownerKeyForSession,
  ownerKeyForUser,
  defaultOwnerFilter,
  buildOwnerOptions,
  filterSessionsByOwner,
  type SessionOwnerFields,
} from './sessionOwnerFilter.js';

const SESSIONS: SessionOwnerFields[] = [
  { sessionId: 's1', ownerUserId: 'u1', ownerName: 'alice' },
  { sessionId: 's2', ownerUserId: 'u2', ownerName: 'bob' },
  { sessionId: 's3', ownerUserId: 'u1', ownerName: 'alice' },
  { sessionId: 's4', ownerUserId: null, ownerName: null },
];

describe('ownerKeyForSession / ownerKeyForUser', () => {
  it('keys by id when present, name otherwise, and matches user keys', () => {
    expect(ownerKeyForSession({ ownerUserId: 'u1', ownerName: 'alice' })).toBe('id:u1');
    expect(ownerKeyForSession({ ownerUserId: '', ownerName: 'alice' })).toBe('name:alice');
    expect(ownerKeyForSession({})).toBe('__unassigned__');
    // A user's own key matches their sessions' key.
    expect(ownerKeyForUser({ id: 'u1', username: 'alice' })).toBe('id:u1');
    expect(ownerKeyForUser({ username: 'alice' })).toBe('name:alice');
    expect(ownerKeyForUser(null)).toBe(null);
  });
});

describe('defaultOwnerFilter', () => {
  it('defaults to the current user, falling back to all', () => {
    expect(defaultOwnerFilter('id:u1')).toBe('id:u1');
    expect(defaultOwnerFilter(null)).toBe(ALL_OWNERS);
    expect(defaultOwnerFilter(undefined)).toBe(ALL_OWNERS);
  });
});

describe('buildOwnerOptions', () => {
  it('leads with All users, then sorted distinct owners with counts', () => {
    const opts = buildOwnerOptions(SESSIONS);
    expect(opts[0]).toEqual({ key: ALL_OWNERS, label: 'All users', count: 4 });
    const rest = opts.slice(1);
    expect(rest.map((o) => o.label)).toEqual(['alice', 'bob', 'Unassigned']);
    expect(rest.find((o) => o.key === 'id:u1')!.count).toBe(2);
    expect(rest.find((o) => o.key === 'id:u2')!.count).toBe(1);
  });

  it('always includes the current user (count 0 when they have nothing in flight)', () => {
    const opts = buildOwnerOptions([{ sessionId: 's1', ownerUserId: 'u2', ownerName: 'bob' }], {
      currentUserKey: 'id:u9',
      currentUserName: 'carol',
    });
    const me = opts.find((o) => o.key === 'id:u9');
    expect(me).toEqual({ key: 'id:u9', label: 'carol', count: 0 });
  });

  it('does not duplicate the current user when they already own sessions', () => {
    const opts = buildOwnerOptions(SESSIONS, { currentUserKey: 'id:u1', currentUserName: 'alice' });
    expect(opts.filter((o) => o.key === 'id:u1')).toHaveLength(1);
    expect(opts.find((o) => o.key === 'id:u1')!.count).toBe(2);
  });

  it('handles empty/invalid input', () => {
    expect(buildOwnerOptions([])).toEqual([{ key: ALL_OWNERS, label: 'All users', count: 0 }]);
    expect(buildOwnerOptions(null)).toEqual([{ key: ALL_OWNERS, label: 'All users', count: 0 }]);
  });
});

describe('filterSessionsByOwner', () => {
  it('returns only the matching owner sessions', () => {
    expect(filterSessionsByOwner(SESSIONS, 'id:u1').map((s) => s.sessionId)).toEqual(['s1', 's3']);
    expect(filterSessionsByOwner(SESSIONS, 'id:u2').map((s) => s.sessionId)).toEqual(['s2']);
  });

  it('passes everything through for ALL_OWNERS or a falsy key', () => {
    expect(filterSessionsByOwner(SESSIONS, ALL_OWNERS)).toHaveLength(4);
    expect(filterSessionsByOwner(SESSIONS, null)).toHaveLength(4);
  });

  it('returns [] when an owner has no in-flight sessions', () => {
    expect(filterSessionsByOwner(SESSIONS, 'id:u9')).toEqual([]);
  });
});
