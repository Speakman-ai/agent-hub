// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { deriveSessionState } from './deriveSessionState';
describe('deriveSessionState', () => {
    it('defaults to waiting for an idle session', () => {
        expect(deriveSessionState({ id: 's1' })).toBe('waiting_for_user_input');
    });
    it('lets live activity override a settled seed', () => {
        expect(deriveSessionState({ id: 's1', state: 'merged' }, { activeTaskSessionIds: { s1: true } })).toBe('working');
    });
    it('uses live finalize status and keeps settled server state seeds', () => {
        expect(deriveSessionState({ id: 's1' }, { finalizeStatusBySession: { s1: 'reviewing' } })).toBe('reviewing');
        expect(deriveSessionState({ id: 's2', state: 'pushed' })).toBe('pushed');
    });
    // A merged session that re-finalizes parks its newest run at ready_to_push
    // (its validated head is the commit that already shipped) — that must not
    // regress the session badge to "Pending push".
    it('keeps merged when a later finalize run parks at ready_to_push', () => {
        expect(deriveSessionState({ id: 's1', state: 'merged' }, { finalizeStatusBySession: { s1: 'ready_to_push' } })).toBe('merged');
    });
});
