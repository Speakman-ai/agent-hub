// @ts-nocheck
import { applyNeedsInputSnapshot, reseedNeedsInputFromSessions } from '@shared/utils/sessionState';
import { describe, it, expect } from 'vitest';
import { deriveSessionState } from './deriveSessionState';
describe('deriveSessionState', () => {
  it('defaults to waiting for an idle session', () => {
    expect(deriveSessionState({ id: 's1' })).toBe('waiting_for_user_input');
  });
  it('lets live activity override a settled seed', () => {
    expect(
      deriveSessionState({ id: 's1', state: 'merged' }, { activeTaskSessionIds: { s1: true } }),
    ).toBe('working');
  });
  it('uses live finalize status and keeps settled server state seeds', () => {
    expect(deriveSessionState({ id: 's1' }, { finalizeStatusBySession: { s1: 'reviewing' } })).toBe(
      'reviewing',
    );
    expect(deriveSessionState({ id: 's2', state: 'pushed' })).toBe('pushed');
  });
  // A merged session that re-finalizes parks its newest run at ready_to_push
  // (its validated head is the commit that already shipped) — that must not
  // regress the session badge to "Pending push".
  it('keeps merged when a later finalize run parks at ready_to_push', () => {
    expect(
      deriveSessionState(
        { id: 's1', state: 'merged' },
        { finalizeStatusBySession: { s1: 'ready_to_push' } },
      ),
    ).toBe('merged');
  });

  it('mirrors web: needs_input wins over a running turn and a live null clears a stale seed', () => {
    expect(
      deriveSessionState(
        { id: 's1' },
        {
          activeTaskSessionIds: { s1: true },
          needsInputBySession: { s1: { kind: 'sign_in', at: 1 } },
        },
      ),
    ).toBe('needs_input');
    const session = { id: 's1', needs_input: 'question', state: 'needs_input' };
    expect(deriveSessionState(session)).toBe('needs_input');
    expect(
      deriveSessionState(session, { needsInputBySession: { s1: { kind: null, at: 1 } } }),
    ).toBe('waiting_for_user_input');
  });

  it('reflects a request raised while disconnected once the payload or snapshot arrives', () => {
    // Live clear recorded before the drop; the refreshed payload reports a question.
    const stale = { s1: { kind: null, at: 1 } };
    const session = {
      id: 's1',
      needs_input: 'question',
      needs_input_at: 50,
      state: 'needs_input',
    };
    // The payload (t=50) is newer than the stale clear (t=1), so it wins even
    // before the map is reseeded.
    expect(deriveSessionState(session, { needsInputBySession: stale })).toBe('needs_input');
    expect(
      deriveSessionState(session, {
        needsInputBySession: reseedNeedsInputFromSessions(stale, [session]),
      }),
    ).toBe('needs_input');
    expect(
      deriveSessionState(
        { id: 's1' },
        {
          needsInputBySession: applyNeedsInputSnapshot([
            { sessionId: 's1', needsInput: 'approval' },
          ]),
        },
      ),
    ).toBe('needs_input');
  });

  it('drops a request resolved while disconnected', () => {
    const stale = { s1: { kind: 'approval', at: 1 } };
    const session = {
      id: 's1',
      needs_input: null,
      needs_input_at: 50,
      state: 'waiting_for_user_input',
    };
    expect(
      deriveSessionState(session, {
        needsInputBySession: reseedNeedsInputFromSessions(stale, [session]),
      }),
    ).toBe('waiting_for_user_input');
  });
});
