// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { selectSessionToActivate, deepLinkFetchId, upsertSessionRow } from './sessionSelection';
// Regression tests for the handoff "Open session" race:
//   handleOpenHandoffSession sets `activeAgentId` + `activeSessionId`
//   optimistically, but the agent-change sessions-load effect would
//   unconditionally overwrite activeSessionId with `data[0].id` once the
//   async fetch resolved. This helper gates that fallback on whether a
//   pending target was requested, so cross-agent handoff navigation lands
//   on the *handoff's* target session, not the newest one for the agent.
describe('selectSessionToActivate', () => {
  const newest = { id: 'newest', engine: 'claude-code' };
  const middle = { id: 'middle', engine: 'claude-code' };
  const oldest = { id: 'oldest', engine: 'claude-code' };
  const sessions = [newest, middle, oldest]; // server returns newest-first
  it('returns null when the sessions list is empty', () => {
    expect(selectSessionToActivate([], 'anything')).toBeNull();
    expect(selectSessionToActivate([], null)).toBeNull();
  });
  it('returns null when sessions is not an array', () => {
    expect(selectSessionToActivate(null, 'anything')).toBeNull();
    expect(selectSessionToActivate(undefined, null)).toBeNull();
  });
  it('defaults to the newest session when no target was requested', () => {
    expect(selectSessionToActivate(sessions, null)).toBe(newest);
    expect(selectSessionToActivate(sessions, undefined)).toBe(newest);
    expect(selectSessionToActivate(sessions, '')).toBe(newest);
  });
  it('honors the target when it exists in the list — even if it is not the newest', () => {
    // This is the scenario the web client's pendingSessionIdRef exists to
    // protect: a handoff into an agent whose newest session is something
    // unrelated. Regression guard for `mobile/src/context/AppContext.js`
    // `handleOpenHandoffSession`.
    expect(selectSessionToActivate(sessions, 'middle')).toBe(middle);
    expect(selectSessionToActivate(sessions, 'oldest')).toBe(oldest);
  });
  it('falls back to the newest session when the requested target no longer exists', () => {
    // A session can be deleted between the navigation request being queued
    // and the sessions list arriving. We still want to land the user
    // somewhere usable rather than leave them on a stale id.
    expect(selectSessionToActivate(sessions, 'deleted-ghost')).toBe(newest);
  });
  it('skips null entries in the sessions list gracefully', () => {
    const noisy = [null, middle, oldest];
    expect(selectSessionToActivate(noisy, 'middle')).toBe(middle);
  });
});
// Dashboard admin click-through: tapping a session you don't own must open it
// by id rather than snapping to your newest owned session.
describe('deepLinkFetchId', () => {
  const owned = [{ id: 'mine-1' }, { id: 'mine-2' }];
  it('returns null when no target was requested', () => {
    expect(deepLinkFetchId(owned, null)).toBeNull();
    expect(deepLinkFetchId(owned, undefined)).toBeNull();
  });
  it('returns null when the target is already in the owned list', () => {
    expect(deepLinkFetchId(owned, 'mine-2')).toBeNull();
  });
  it('returns the target id when it is not in the owned list (non-owned deep-link)', () => {
    expect(deepLinkFetchId(owned, 'kevins-session')).toBe('kevins-session');
  });
  it('signals a fetch even when the caller owns no sessions for the agent', () => {
    expect(deepLinkFetchId([], 'kevins-session')).toBe('kevins-session');
  });
});
describe('upsertSessionRow', () => {
  it('prepends a new deep-linked row', () => {
    const out = upsertSessionRow([{ id: 'a' }], { id: 'b', engine: 'claude-code' });
    expect(out.map((s) => s.id)).toEqual(['b', 'a']);
  });
  it('replaces an existing row in place', () => {
    const out = upsertSessionRow([{ id: 'a', model: 'old' }, { id: 'b' }], {
      id: 'a',
      model: 'new',
    });
    expect(out.map((s) => s.id)).toEqual(['a', 'b']);
    expect(out[0].model).toBe('new');
  });
  it('ignores a row without an id', () => {
    const list = [{ id: 'a' }];
    expect(upsertSessionRow(list, null)).toBe(list);
  });
});
