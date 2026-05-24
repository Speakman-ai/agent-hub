import { describe, it, expect } from 'vitest';
import {
  applyAwaitingInputEvent,
  applyAwaitingInputSnapshot,
  clearAwaitingInputForSession,
  shouldNotifyForAwaitingInput,
} from './awaitingInputState.js';

describe('applyAwaitingInputSnapshot', () => {
  it('returns an empty object for null/undefined/empty inputs', () => {
    expect(applyAwaitingInputSnapshot(null)).toEqual({});
    expect(applyAwaitingInputSnapshot(undefined)).toEqual({});
    expect(applyAwaitingInputSnapshot([])).toEqual({});
  });

  it('builds a sessionId-keyed map from valid items', () => {
    const out = applyAwaitingInputSnapshot([
      { sessionId: 'a', askIds: ['ask-1'], agentId: 'ag-1', sessionName: 'Alpha' },
      { sessionId: 'b', askIds: ['ask-2', 'ask-3'], agentId: 'ag-2', sessionName: 'Beta' },
    ]);
    expect(Object.keys(out)).toEqual(['a', 'b']);
    expect(out.a).toEqual({ askIds: ['ask-1'], agentId: 'ag-1', sessionName: 'Alpha' });
    expect(out.b.askIds).toEqual(['ask-2', 'ask-3']);
  });

  it('skips malformed rows but keeps the rest', () => {
    const out = applyAwaitingInputSnapshot([
      null,
      { sessionId: '' },
      { foo: 'bar' },
      { sessionId: 'good', askIds: 'oops' },
    ]);
    expect(out.good).toEqual({ askIds: [], agentId: null, sessionName: null });
  });
});

describe('applyAwaitingInputEvent', () => {
  it('returns prev unchanged when sessionId is missing', () => {
    const prev = {};
    expect(applyAwaitingInputEvent(prev, { waiting: true })).toBe(prev);
  });

  it('adds a new entry when waiting:true on a fresh session', () => {
    const next = applyAwaitingInputEvent(
      {},
      { sessionId: 's1', waiting: true, askIds: ['ask-1'], agentId: 'a', sessionName: 'S1' },
    );
    expect(next.s1).toEqual({ askIds: ['ask-1'], agentId: 'a', sessionName: 'S1' });
  });

  it('returns the same reference when the incoming event matches existing state', () => {
    const prev = {
      s1: { askIds: ['ask-1'], agentId: 'a', sessionName: 'S1' },
    };
    const next = applyAwaitingInputEvent(prev, {
      sessionId: 's1',
      waiting: true,
      askIds: ['ask-1'],
      agentId: 'a',
      sessionName: 'S1',
    });
    expect(next).toBe(prev);
  });

  it('updates askIds when a multi-round ask flow emits new ids', () => {
    const prev = { s1: { askIds: ['ask-1'], agentId: 'a', sessionName: 'S1' } };
    const next = applyAwaitingInputEvent(prev, {
      sessionId: 's1',
      waiting: true,
      askIds: ['ask-2'],
      agentId: 'a',
      sessionName: 'S1',
    });
    expect(next).not.toBe(prev);
    expect(next.s1.askIds).toEqual(['ask-2']);
  });

  it('drops the entry when waiting:false', () => {
    const prev = { s1: { askIds: ['ask-1'], agentId: null, sessionName: null } };
    const next = applyAwaitingInputEvent(prev, { sessionId: 's1', waiting: false });
    expect(next.s1).toBeUndefined();
  });

  it('returns the same reference when waiting:false on a session already absent', () => {
    const prev = {};
    const next = applyAwaitingInputEvent(prev, { sessionId: 's-missing', waiting: false });
    expect(next).toBe(prev);
  });
});

describe('clearAwaitingInputForSession', () => {
  it('returns the same reference when the id is absent', () => {
    const prev = { other: { askIds: [], agentId: null, sessionName: null } };
    expect(clearAwaitingInputForSession(prev, 'missing')).toBe(prev);
    expect(clearAwaitingInputForSession(prev, null)).toBe(prev);
    expect(clearAwaitingInputForSession(prev, undefined)).toBe(prev);
  });

  it('removes the matching entry while preserving the rest', () => {
    const prev = {
      a: { askIds: ['x'], agentId: null, sessionName: null },
      b: { askIds: ['y'], agentId: null, sessionName: null },
    };
    const next = clearAwaitingInputForSession(prev, 'a');
    expect(next).not.toBe(prev);
    expect(next.a).toBeUndefined();
    expect(next.b).toBe(prev.b);
  });
});

describe('shouldNotifyForAwaitingInput', () => {
  it('fires for a fresh waiting transition on a non-active session', () => {
    expect(
      shouldNotifyForAwaitingInput({
        wasWaiting: false,
        sessionId: 's1',
        activeSessionId: 's-other',
      }),
    ).toBe(true);
  });

  it('suppresses on snapshot replay (already waiting)', () => {
    expect(
      shouldNotifyForAwaitingInput({
        wasWaiting: true,
        sessionId: 's1',
        activeSessionId: null,
      }),
    ).toBe(false);
  });

  it('suppresses when the user is already viewing the session', () => {
    expect(
      shouldNotifyForAwaitingInput({
        wasWaiting: false,
        sessionId: 's1',
        activeSessionId: 's1',
      }),
    ).toBe(false);
  });

  it('suppresses when sessionId is missing', () => {
    expect(
      shouldNotifyForAwaitingInput({
        wasWaiting: false,
        sessionId: null,
        activeSessionId: 's-other',
      }),
    ).toBe(false);
  });

  it('handles the multi-round case: after a clear, a new waiting:true fires again', () => {
    // ask-1 arrives → notify
    const stage1 = shouldNotifyForAwaitingInput({
      wasWaiting: false,
      sessionId: 's1',
      activeSessionId: 's-other',
    });
    // user answers → state cleared → wasWaiting goes back to false.
    // ask-2 arrives → notify again
    const stage2 = shouldNotifyForAwaitingInput({
      wasWaiting: false,
      sessionId: 's1',
      activeSessionId: 's-other',
    });
    expect(stage1).toBe(true);
    expect(stage2).toBe(true);
  });
});
