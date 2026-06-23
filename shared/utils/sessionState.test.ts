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
