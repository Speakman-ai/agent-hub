// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { selectSessionToActivate } from './sessionSelection';
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
