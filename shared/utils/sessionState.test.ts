import { describe, it, expect } from 'vitest';
import {
  SESSION_STATES,
  DEFAULT_SESSION_STATE,
  isSessionState,
  finalizeStatusToState,
  resolveSessionState,
  SESSION_STATE_META,
  sessionStateMeta,
  groupSessionsByState,
  buildSessionBoardColumns,
  needsInputLabel,
  applyNeedsInputSnapshot,
  applyNeedsInputEvent,
  liveNeedsInputKind,
  reseedNeedsInputFromSessions,
  isNeedsInputKind,
  isSessionsViewMode,
} from './sessionState.js';

describe('finalizeStatusToState', () => {
  it.each([
    ['running', 'running_tests'],
    ['reviewing', 'reviewing'],
    ['queued', 'pending_checks'],
    ['rebasing', 'pending_checks'],
    ['dispatching', 'pending_checks'],
    ['checks_passed', 'pending_checks'],
    ['review_passed', 'pending_checks'],
    ['pushing', 'pending_push'],
    ['ready_to_push', 'pending_push'],
    ['pushed', 'pushed'],
  ])('maps %s → %s', (status, expected) => {
    expect(finalizeStatusToState(status)).toBe(expected);
  });

  it.each(['failed', 'timed_out', 'infra_error', 'cancelled', 'stalled_no_response', 'whatever'])(
    'returns null for non-determining status %s',
    (status) => {
      expect(finalizeStatusToState(status)).toBeNull();
    },
  );

  it('returns null for empty input', () => {
    expect(finalizeStatusToState(null)).toBeNull();
    expect(finalizeStatusToState(undefined)).toBeNull();
    expect(finalizeStatusToState('')).toBeNull();
  });
});

describe('resolveSessionState', () => {
  it('defaults to waiting when idle', () => {
    expect(resolveSessionState({})).toBe('waiting_for_user_input');
  });
  it('working when a task is active and no finalize', () => {
    expect(resolveSessionState({ hasActiveTask: true })).toBe('working');
  });
  it('finalize phase outranks an active task', () => {
    expect(resolveSessionState({ hasActiveTask: true, finalizeStatus: 'reviewing' })).toBe(
      'reviewing',
    );
  });
  it('merged shows when the session is otherwise settled', () => {
    expect(resolveSessionState({ merged: true })).toBe('merged');
    expect(resolveSessionState({ merged: true, finalizeStatus: 'pushed' })).toBe('merged');
  });

  it('live activity outranks the sticky merged marker', () => {
    expect(resolveSessionState({ merged: true, hasActiveTask: true })).toBe('working');
    expect(resolveSessionState({ merged: true, finalizeStatus: 'running' })).toBe('running_tests');
  });

  // A merged session that re-finalizes (review feedback, a follow-up turn)
  // parks its newest run at ready_to_push because the validated head is
  // already pushed. Reporting that regressed the top bar to "Pending push"
  // next to a "#772 · Merged" PR pill.
  it.each(['ready_to_push', 'pushing'])(
    'keeps merged when a later run parks at %s',
    (finalizeStatus) => {
      expect(resolveSessionState({ merged: true, finalizeStatus })).toBe('merged');
    },
  );

  it('still reports the push stage when the session has not merged', () => {
    expect(resolveSessionState({ finalizeStatus: 'ready_to_push' })).toBe('pending_push');
    expect(resolveSessionState({ finalizeStatus: 'pushing' })).toBe('pending_push');
    expect(resolveSessionState({ finalizeStatus: 'pushed' })).toBe('pushed');
  });
});

describe('SESSION_STATE_META', () => {
  it('has metadata for every state and only those states', () => {
    expect(Object.keys(SESSION_STATE_META).sort()).toEqual([...SESSION_STATES].sort());
  });

  it('every state has a non-empty icon, label and valid anim', () => {
    for (const state of SESSION_STATES) {
      const m = SESSION_STATE_META[state];
      expect(m.icon).toBeTruthy();
      expect(m.label).toBeTruthy();
      expect(m.short).toBeTruthy();
      expect(['spin', 'pulse', 'none']).toContain(m.anim);
    }
  });

  it('icon names match the agreed lucide glyphs', () => {
    expect(SESSION_STATE_META.waiting_for_user_input.icon).toBe('MessageCircleQuestion');
    expect(SESSION_STATE_META.working.icon).toBe('Loader2');
    expect(SESSION_STATE_META.running_tests.icon).toBe('FlaskConical');
    expect(SESSION_STATE_META.reviewing.icon).toBe('ScanEye');
    expect(SESSION_STATE_META.pending_checks.icon).toBe('Clock');
    expect(SESSION_STATE_META.pending_push.icon).toBe('ArrowUpCircle');
    expect(SESSION_STATE_META.pushed.icon).toBe('CloudUpload');
    expect(SESSION_STATE_META.merged.icon).toBe('GitMerge');
    expect(SESSION_STATE_META.needs_input.icon).toBe('CircleAlert');
  });
});

describe('needs_input state', () => {
  it('wins over every other signal, including a live turn parked on an approval', () => {
    expect(resolveSessionState({ needsInput: 'approval', hasActiveTask: true })).toBe(
      'needs_input',
    );
    expect(resolveSessionState({ needsInput: 'question', finalizeStatus: 'running' })).toBe(
      'needs_input',
    );
  });

  it('maps a disputed Finalize run to needs_input, but a live reply turn shows working', () => {
    expect(finalizeStatusToState('disputed')).toBe('needs_input');
    expect(resolveSessionState({ finalizeStatus: 'disputed' })).toBe('needs_input');
    expect(resolveSessionState({ finalizeStatus: 'disputed', hasActiveTask: true })).toBe(
      'working',
    );
  });

  it('labels each reason and falls back to the generic label', () => {
    expect(needsInputLabel('credential')).toMatch(/password/);
    expect(needsInputLabel('review_disputed')).toMatch(/disputed review/);
    expect(needsInputLabel(null)).toBe('Needs your input');
    expect(isNeedsInputKind('sign_in')).toBe(true);
    expect(isNeedsInputKind('bogus')).toBe(false);
  });

  it('only gets a board column while a session needs input', () => {
    expect(buildSessionBoardColumns([]).some((c) => c.state === 'needs_input')).toBe(false);
    const cols = buildSessionBoardColumns([{ sessionId: 'd', state: 'needs_input' }]);
    expect(cols.find((c) => c.state === 'needs_input')?.sessions).toHaveLength(1);
  });
});

describe('sessionStateMeta', () => {
  it('returns the matching meta', () => {
    expect(sessionStateMeta('merged').icon).toBe('GitMerge');
  });
  it('falls back to the default state for unknown/null so an icon is always present', () => {
    expect(sessionStateMeta('bogus')).toBe(SESSION_STATE_META[DEFAULT_SESSION_STATE]);
    expect(sessionStateMeta(null)).toBe(SESSION_STATE_META[DEFAULT_SESSION_STATE]);
    expect(sessionStateMeta(undefined)).toBe(SESSION_STATE_META[DEFAULT_SESSION_STATE]);
  });
});

describe('groupSessionsByState', () => {
  it('buckets sessions and orders groups by canonical pipeline order', () => {
    const sessions = [
      { sessionId: 'a', state: 'reviewing' },
      { sessionId: 'b', state: 'working' },
      { sessionId: 'c', state: 'working' },
      { sessionId: 'd', state: 'merged' },
    ];
    const groups = groupSessionsByState(sessions);
    // working precedes reviewing precedes merged in SESSION_STATES order.
    expect(groups.map((g) => g.state)).toEqual(['working', 'reviewing', 'merged']);
    const working = groups.find((g) => g.state === 'working')!;
    expect(working.sessions.map((s) => s.sessionId)).toEqual(['b', 'c']);
    expect(working.meta).toBe(SESSION_STATE_META.working);
  });

  it('only emits states that have at least one session', () => {
    const groups = groupSessionsByState([{ sessionId: 'a', state: 'pushed' }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].state).toBe('pushed');
  });

  it('preserves insertion order within a bucket', () => {
    const groups = groupSessionsByState([
      { sessionId: 'x', state: 'working' },
      { sessionId: 'y', state: 'working' },
      { sessionId: 'z', state: 'working' },
    ]);
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(['x', 'y', 'z']);
  });

  it('folds unknown/missing states into the default bucket', () => {
    const groups = groupSessionsByState([
      { sessionId: 'a', state: 'bogus' },
      { sessionId: 'b' },
      { sessionId: 'c', state: null },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].state).toBe(DEFAULT_SESSION_STATE);
    expect(groups[0].sessions).toHaveLength(3);
  });

  it('returns an empty array for empty/invalid input', () => {
    expect(groupSessionsByState([])).toEqual([]);
    expect(groupSessionsByState(undefined)).toEqual([]);
    expect(groupSessionsByState(null)).toEqual([]);
  });
});

describe('isSessionState', () => {
  it('accepts canonical values, rejects junk', () => {
    expect(isSessionState('pushed')).toBe(true);
    expect(isSessionState('nope')).toBe(false);
    expect(isSessionState(3)).toBe(false);
  });
});

describe('buildSessionBoardColumns', () => {
  it('emits every in-flight column in pipeline order, including empty ones', () => {
    const cols = buildSessionBoardColumns([
      { sessionId: 'a', state: 'reviewing' },
      { sessionId: 'b', state: 'bogus' },
    ]);
    expect(cols.map((c) => c.state)).toEqual([
      'waiting_for_user_input',
      'working',
      'running_tests',
      'reviewing',
      'pending_checks',
      'pending_push',
    ]);
    expect(cols[0].sessions.map((s) => s.sessionId)).toEqual(['b']);
    expect(cols[3].sessions.map((s) => s.sessionId)).toEqual(['a']);
    expect(cols[1].sessions).toEqual([]);
  });

  it('adds a merged column only when a merged session is present', () => {
    const cols = buildSessionBoardColumns([{ sessionId: 'm', state: 'merged' }]);
    expect(cols[cols.length - 1].state).toBe('merged');
    expect(cols[cols.length - 1].sessions).toHaveLength(1);
    expect(buildSessionBoardColumns(null)).toHaveLength(6);
  });

  it('omits the Pushed column unless a pushed session is present', () => {
    expect(buildSessionBoardColumns([]).some((c) => c.state === 'pushed')).toBe(false);
    const cols = buildSessionBoardColumns([{ sessionId: 'p', state: 'pushed' }]);
    const pushed = cols.find((c) => c.state === 'pushed');
    expect(pushed?.sessions.map((s) => s.sessionId)).toEqual(['p']);
  });
});

describe('isSessionsViewMode', () => {
  it('accepts list and board only', () => {
    expect(isSessionsViewMode('list')).toBe(true);
    expect(isSessionsViewMode('board')).toBe(true);
    expect(isSessionsViewMode('grid')).toBe(false);
    expect(isSessionsViewMode(null)).toBe(false);
  });
});

describe('needs-input reconciliation', () => {
  it('a reconnect snapshot replaces stale entries in both directions', () => {
    const map = applyNeedsInputSnapshot([
      { sessionId: 's1', needsInput: 'question', at: 10 },
      { sessionId: 's2', needsInput: null, at: 10 },
      { sessionId: 's3', needsInput: 'bogus', at: 10 },
      { nope: true },
    ]);
    expect(map).toEqual({
      s1: { kind: 'question', at: 10 },
      s2: { kind: null, at: 10 },
      s3: { kind: null, at: 10 },
    });
    expect(applyNeedsInputSnapshot(null)).toEqual({});
  });

  it('ignores an event older than the entry already held', () => {
    let map = applyNeedsInputEvent({}, { sessionId: 's1', needsInput: null, at: 20 });
    map = applyNeedsInputEvent(map, { sessionId: 's1', needsInput: 'approval', at: 15 });
    expect(liveNeedsInputKind({ id: 's1', needs_input: 'approval' }, map)).toBeNull();
  });

  it('keeps an event that landed while a fetch was in flight (fetch computed, event, response)', () => {
    // Server computed the payload at t=100 (approval pending). The approval is
    // answered and the null event (t=105) arrives before the fetch response.
    const map = applyNeedsInputEvent({}, { sessionId: 's1', needsInput: null, at: 105 });
    const payload = { id: 's1', needs_input: 'approval', needs_input_at: 100 };
    const next = reseedNeedsInputFromSessions(map, [payload]);
    expect(next).toBe(map);
    expect(liveNeedsInputKind(payload, next)).toBeNull();
  });

  it('rejects a delayed event computed before a payload that already arrived', () => {
    // Payload computed at t=30 says cleared; an approval event computed at t=20
    // arrives late over the socket.
    const payload = { id: 's1', needs_input: null, needs_input_at: 30 };
    let map = reseedNeedsInputFromSessions({ s1: { kind: 'approval', at: 10 } }, [payload]);
    map = applyNeedsInputEvent(map, { sessionId: 's1', needsInput: 'approval', at: 20 });
    expect(liveNeedsInputKind(payload, map)).toBeNull();
    // Same ordering with no prior entry, raising a new request.
    const raised = { id: 's2', needs_input: 'question', needs_input_at: 30 };
    let m2 = reseedNeedsInputFromSessions({}, [raised]);
    m2 = applyNeedsInputEvent(m2, { sessionId: 's2', needsInput: null, at: 20 });
    expect(liveNeedsInputKind(raised, m2)).toBe('question');
  });

  it('prefers a newer payload even when the map was not reseeded', () => {
    const map = applyNeedsInputEvent({}, { sessionId: 's1', needsInput: 'approval', at: 20 });
    expect(liveNeedsInputKind({ id: 's1', needs_input: null, needs_input_at: 30 }, map)).toBeNull();
    expect(liveNeedsInputKind({ id: 's1', needs_input: null, needs_input_at: 10 }, map)).toBe(
      'approval',
    );
    expect(liveNeedsInputKind({ id: 's1', needs_input: null }, map)).toBe('approval');
  });

  it('lets a newer payload replace an older live entry in both directions', () => {
    const map = {
      s1: { kind: null, at: 1 },
      s2: { kind: 'approval', at: 1 },
      s9: { kind: 'question', at: 1 },
    };
    const sessions = [
      { id: 's1', needs_input: 'question', needs_input_at: 50 },
      { id: 's2', needs_input: null, needs_input_at: 50 },
    ];
    const next = reseedNeedsInputFromSessions(map, sessions);
    expect(next).toEqual({
      s1: { kind: 'question', at: 50 },
      s2: { kind: null, at: 50 },
      s9: { kind: 'question', at: 1 },
    });
    expect(liveNeedsInputKind(sessions[0], next)).toBe('question');
    expect(liveNeedsInputKind(sessions[1], next)).toBeNull();
    // Rows without a timestamp and empty lists leave the map alone.
    expect(reseedNeedsInputFromSessions(map, [{ id: 's9', needs_input: null }])).toBe(map);
    expect(reseedNeedsInputFromSessions(map, [])).toBe(map);
  });
});
