import { describe, it, expect } from 'vitest';
import {
  resolveSessionState,
  recomputeSessionState,
  isSessionState,
  SESSION_STATES,
  DEFAULT_SESSION_STATE,
  type SessionStateSignals,
} from './session-state.js';

const base: SessionStateSignals = {
  finalizeStatus: null,
  hasActiveTask: false,
  merged: false,
};

describe('resolveSessionState', () => {
  it('defaults to waiting_for_user_input when nothing is active', () => {
    expect(resolveSessionState(base)).toBe('waiting_for_user_input');
    expect(DEFAULT_SESSION_STATE).toBe('waiting_for_user_input');
  });

  it('reports working when an active task is running and no finalize in flight', () => {
    expect(resolveSessionState({ ...base, hasActiveTask: true })).toBe('working');
  });

  it.each([
    ['running', 'running_tests'],
    ['reviewing', 'reviewing'],
    ['queued', 'pending_checks'],
    ['rebasing', 'pending_checks'],
    ['dispatching', 'pending_checks'],
    ['pushing', 'pending_push'],
    ['ready_to_push', 'pending_push'],
    ['pushed', 'pushed'],
  ])('maps finalize status %s → %s', (finalizeStatus, expected) => {
    expect(resolveSessionState({ ...base, finalizeStatus })).toBe(expected);
  });

  it.each(['checks_passed', 'review_passed'])(
    'treats single-phase park %s as pending_checks',
    (finalizeStatus) => {
      expect(resolveSessionState({ ...base, finalizeStatus })).toBe('pending_checks');
    },
  );

  it('merged shows for a settled session whose card landed in Done', () => {
    expect(resolveSessionState({ ...base, merged: true })).toBe('merged');
  });

  it('live activity outranks the sticky merged marker (reopened Done session)', () => {
    // A reopened session that is actively working must NOT show the terminal
    // merged icon — live signals win.
    expect(resolveSessionState({ ...base, merged: true, hasActiveTask: true })).toBe('working');
    expect(resolveSessionState({ ...base, merged: true, finalizeStatus: 'running' })).toBe(
      'running_tests',
    );
  });

  it('merged outranks a settled pushed (merge is the later terminal state)', () => {
    expect(resolveSessionState({ ...base, merged: true, finalizeStatus: 'pushed' })).toBe('merged');
  });

  it('finalize phase outranks a lingering active task', () => {
    expect(resolveSessionState({ ...base, finalizeStatus: 'reviewing', hasActiveTask: true })).toBe(
      'reviewing',
    );
  });

  it.each(['failed', 'timed_out', 'infra_error', 'cancelled', 'stalled_no_response'])(
    'falls through terminal-failure finalize status %s to working when a task is active',
    (finalizeStatus) => {
      expect(resolveSessionState({ ...base, finalizeStatus, hasActiveTask: true })).toBe('working');
    },
  );

  it.each(['failed', 'timed_out', 'infra_error', 'cancelled', 'stalled_no_response'])(
    'falls through terminal-failure finalize status %s to waiting when idle',
    (finalizeStatus) => {
      expect(resolveSessionState({ ...base, finalizeStatus })).toBe('waiting_for_user_input');
    },
  );

  it('unknown finalize strings fall through rather than throwing', () => {
    expect(resolveSessionState({ ...base, finalizeStatus: 'something_new' })).toBe(
      'waiting_for_user_input',
    );
  });

  it('every resolved value is a member of SESSION_STATES', () => {
    const samples: SessionStateSignals[] = [
      base,
      { ...base, hasActiveTask: true },
      { ...base, finalizeStatus: 'running' },
      { ...base, finalizeStatus: 'pushed' },
      { ...base, merged: true },
    ];
    for (const s of samples) {
      expect(SESSION_STATES).toContain(resolveSessionState(s));
    }
  });
});

describe('isSessionState', () => {
  it('accepts canonical values and rejects junk', () => {
    expect(isSessionState('merged')).toBe(true);
    expect(isSessionState('working')).toBe(true);
    expect(isSessionState('nope')).toBe(false);
    expect(isSessionState(null)).toBe(false);
    expect(isSessionState(7)).toBe(false);
  });
});

describe('recomputeSessionState', () => {
  it('persists and broadcasts the resolved state at a live signal boundary', () => {
    const updates: unknown[][] = [];
    const broadcasts: unknown[] = [];
    const stmts = {
      getLatestFinalizeRunForSession: { get: () => undefined },
      getActiveTask: { get: () => undefined },
      getKanbanCardBySession: { get: () => ({ column_id: 'done-col' }) },
      getKanbanColumn: { get: () => ({ name: 'Done' }) },
      updateSessionState: { run: (...args: unknown[]) => updates.push(args) },
    };

    const state = recomputeSessionState(stmts as never, 'sess-1', {
      agentId: 'agent-1',
      broadcast: (msg) => broadcasts.push(msg),
    });

    expect(state).toBe('merged');
    expect(updates).toEqual([['merged', 'sess-1']]);
    expect(broadcasts).toEqual([
      { type: 'session_state', sessionId: 'sess-1', agentId: 'agent-1', state: 'merged' },
    ]);
  });
});
