import {
  applyNeedsInputEvent,
  applyNeedsInputSnapshot,
  reseedNeedsInputFromSessions,
} from '@shared/utils/sessionState';
import { describe, it, expect } from 'vitest';
import { deriveSessionState } from './deriveSessionState';

describe('deriveSessionState', () => {
  it('shows needs_input over an active task while a turn waits on an approval or sign-in', () => {
    expect(
      deriveSessionState(
        { id: 's1' },
        {
          activeTaskSessionIds: { s1: true },
          needsInputBySession: { s1: { kind: 'approval', at: 1 } },
        },
      ),
    ).toBe('needs_input');
  });

  it('seeds needs_input from the payload and lets a live null clear it', () => {
    const session = { id: 's1', needs_input: 'credential', state: 'needs_input' };
    expect(deriveSessionState(session)).toBe('needs_input');
    expect(
      deriveSessionState(session, { needsInputBySession: { s1: { kind: null, at: 1 } } }),
    ).toBe('waiting_for_user_input');
  });

  it('treats a disputed Finalize run as needs_input until the human starts a turn', () => {
    expect(deriveSessionState({ id: 's1' }, { finalizeStatusBySession: { s1: 'disputed' } })).toBe(
      'needs_input',
    );
    expect(
      deriveSessionState(
        { id: 's1' },
        { finalizeStatusBySession: { s1: 'disputed' }, activeTaskSessionIds: { s1: true } },
      ),
    ).toBe('working');
  });

  it('defaults to waiting for an idle session with no signals', () => {
    expect(deriveSessionState({ id: 's1' })).toBe('waiting_for_user_input');
  });

  it('returns working when the session has an active task', () => {
    expect(deriveSessionState({ id: 's1' }, { activeTaskSessionIds: { s1: true } })).toBe(
      'working',
    );
  });

  it('prefers a live finalize status over the payload seed', () => {
    expect(
      deriveSessionState(
        { id: 's1', finalize_status: 'reviewing' },
        { finalizeStatusBySession: { s1: 'pushed' } },
      ),
    ).toBe('pushed');
  });

  it('uses the payload finalize_status when no live signal is present', () => {
    expect(deriveSessionState({ id: 's1', finalize_status: 'running' })).toBe('running_tests');
  });

  it('maps ready_to_push to pending_push', () => {
    expect(
      deriveSessionState({ id: 's1' }, { finalizeStatusBySession: { s1: 'ready_to_push' } }),
    ).toBe('pending_push');
  });

  it('treats a merged seed as merged (no live client signal exists)', () => {
    expect(deriveSessionState({ id: 's1', state: 'merged' })).toBe('merged');
  });

  it('keeps an advanced settled server state when no live signal contradicts it', () => {
    // server resolved `pushed`, but the client has no finalize_status / live map yet
    expect(deriveSessionState({ id: 's1', state: 'pushed' })).toBe('pushed');
  });

  // Reported: the top bar showed "Pending push" beside a "#772 · Merged" PR
  // pill because the session re-finalized after its PR merged and the newest
  // run parks at ready_to_push (its validated head is already pushed).
  it('keeps a merged session merged when a later finalize run parks at ready_to_push', () => {
    expect(
      deriveSessionState(
        { id: 's1', state: 'merged', finalize_status: 'ready_to_push' },
        { finalizeStatusBySession: { s1: 'ready_to_push' } },
      ),
    ).toBe('merged');
  });

  it('lets an active task override a stale settled seed', () => {
    expect(
      deriveSessionState({ id: 's1', state: 'pushed' }, { activeTaskSessionIds: { s1: true } }),
    ).toBe('working');
  });

  it('is robust to a null session', () => {
    expect(deriveSessionState(null)).toBe('waiting_for_user_input');
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

  it('keeps a clear that arrived while a session fetch was in flight', () => {
    // Fetch computed at t=100 with an approval pending; the null event (t=105)
    // lands before the response.
    const live = applyNeedsInputEvent({}, { sessionId: 's1', needsInput: null, at: 105 });
    const session = {
      id: 's1',
      needs_input: 'approval',
      needs_input_at: 100,
      state: 'needs_input',
    };
    expect(
      deriveSessionState(session, {
        needsInputBySession: reseedNeedsInputFromSessions(live, [session]),
      }),
    ).toBe('waiting_for_user_input');
  });
});
