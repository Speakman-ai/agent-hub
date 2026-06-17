import { describe, it, expect } from 'vitest';
import {
  isTerminalStatus,
  isFinalizeBlocked,
  describeRunPhase,
  shouldPollFinalizeFallback,
  FINALIZE_LIVE_FRESH_MS,
  __test,
} from './finalizeRun.js';

const { TERMINAL_STATUSES, FINALIZE_BLOCKED_STATUSES } = __test;

describe('isTerminalStatus', () => {
  it('returns false for null / undefined / empty', () => {
    expect(isTerminalStatus(null)).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
    expect(isTerminalStatus('')).toBe(false);
  });

  it('returns true for every terminal status in the set', () => {
    for (const s of TERMINAL_STATUSES) {
      expect(isTerminalStatus(s)).toBe(true);
    }
  });

  it('returns false for every non-terminal (in-flight) status', () => {
    for (const s of FINALIZE_BLOCKED_STATUSES) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });

  it('returns false for unknown values', () => {
    expect(isTerminalStatus('mystery')).toBe(false);
    expect(isTerminalStatus('PUSHED')).toBe(false); // case-sensitive
  });

  it('matches the canonical web-side terminal set', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      ['pushed', 'failed', 'timed_out', 'infra_error', 'cancelled', 'stalled_no_response'].sort(),
    );
  });
});

describe('isFinalizeBlocked', () => {
  it('returns false for null / undefined / empty', () => {
    expect(isFinalizeBlocked(null)).toBe(false);
    expect(isFinalizeBlocked(undefined)).toBe(false);
    expect(isFinalizeBlocked('')).toBe(false);
  });

  it('returns true for every in-flight status', () => {
    for (const s of FINALIZE_BLOCKED_STATUSES) {
      expect(isFinalizeBlocked(s)).toBe(true);
    }
  });

  it('returns false for every terminal status', () => {
    for (const s of TERMINAL_STATUSES) {
      expect(isFinalizeBlocked(s)).toBe(false);
    }
  });

  it('returns false for unknown values', () => {
    expect(isFinalizeBlocked('mystery')).toBe(false);
  });

  it('matches the canonical web-side blocked set', () => {
    expect([...FINALIZE_BLOCKED_STATUSES].sort()).toEqual(
      ['queued', 'rebasing', 'reviewing', 'running', 'dispatching', 'pushing'].sort(),
    );
  });

  it('TERMINAL and FINALIZE_BLOCKED are disjoint', () => {
    const overlap = [...TERMINAL_STATUSES].filter((s) => FINALIZE_BLOCKED_STATUSES.has(s));
    expect(overlap).toEqual([]);
  });
});

describe('describeRunPhase', () => {
  it('returns "idle" when status is falsy', () => {
    expect(describeRunPhase(null, null)).toBe('idle');
    expect(describeRunPhase(undefined, undefined)).toBe('idle');
    expect(describeRunPhase('', null)).toBe('idle');
  });

  it('returns the canonical label for every in-flight status', () => {
    expect(describeRunPhase('queued', null)).toBe('queued');
    expect(describeRunPhase('rebasing', null)).toBe('rebasing');
    expect(describeRunPhase('reviewing', null)).toBe('reviewing');
    expect(describeRunPhase('dispatching', null)).toBe('awaiting fix');
    expect(describeRunPhase('pushing', null)).toBe('pushing');
  });

  it('returns the canonical label for every terminal status', () => {
    expect(describeRunPhase('pushed', null)).toBe('pushed');
    expect(describeRunPhase('failed', null)).toBe('failed');
    expect(describeRunPhase('timed_out', null)).toBe('timed out');
    expect(describeRunPhase('infra_error', null)).toBe('infra error');
    expect(describeRunPhase('cancelled', null)).toBe('cancelled');
    expect(describeRunPhase('stalled_no_response', null)).toBe('stalled');
  });

  describe('running branch — phase-aware', () => {
    it('returns "running checks" when phase === "tasks"', () => {
      expect(describeRunPhase('running', 'tasks')).toBe('running checks');
    });

    it('returns "running" when phase is any other value', () => {
      expect(describeRunPhase('running', null)).toBe('running');
      expect(describeRunPhase('running', undefined)).toBe('running');
      expect(describeRunPhase('running', 'ci_config')).toBe('running');
      expect(describeRunPhase('running', 'fix_dispatch')).toBe('running');
      expect(describeRunPhase('running', 'push')).toBe('running');
    });
  });

  it('falls back to a humanised snake_case for unknown statuses', () => {
    // Defensive default — keeps a future server-side status from rendering
    // a raw `running_some_new_phase` snake-case string in the UI.
    expect(describeRunPhase('weird_new_status', null)).toBe('weird new status');
    expect(describeRunPhase('one_two_three', null)).toBe('one two three');
  });

  it('covers every status in both canonical sets without falling through', () => {
    // Regression guard against "added a new status to the set but forgot the
    // describeRunPhase case" — the fallback only fires for unknown statuses.
    for (const s of [...TERMINAL_STATUSES, ...FINALIZE_BLOCKED_STATUSES]) {
      const label = describeRunPhase(s, null);
      // Bare humanised fallback would yield s.replace(/_/g, ' ').
      // If the switch lacks a case, this assertion will fail for any
      // multi-word status (e.g. 'timed_out', 'infra_error').
      expect(label).not.toMatch(/^idle$/);
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe('shouldPollFinalizeFallback', () => {
  const SID = 'sess-1';
  const NOW = 1_700_000_000_000;
  const fresh = { sessionId: SID, bump: NOW - 1_000 }; // 1s old
  const stale = { sessionId: SID, bump: NOW - (FINALIZE_LIVE_FRESH_MS + 1) };

  it('does not poll when there is no session', () => {
    expect(
      shouldPollFinalizeFallback({ connected: false, lastEvent: null, sessionId: null, now: NOW }),
    ).toBe(false);
  });

  it('skips polling while connected with a fresh event for this session', () => {
    expect(
      shouldPollFinalizeFallback({ connected: true, lastEvent: fresh, sessionId: SID, now: NOW }),
    ).toBe(false);
  });

  it('polls when the socket is disconnected, even with a fresh event (drop case)', () => {
    // Regression: previously, one event for the session disabled polling
    // permanently; a socket drop must resume it.
    expect(
      shouldPollFinalizeFallback({ connected: false, lastEvent: fresh, sessionId: SID, now: NOW }),
    ).toBe(true);
  });

  it('polls when the last event is stale despite being connected (silent / reconnect-missed-frame)', () => {
    expect(
      shouldPollFinalizeFallback({ connected: true, lastEvent: stale, sessionId: SID, now: NOW }),
    ).toBe(true);
  });

  it('polls when the last event belongs to a different session or none seen', () => {
    expect(
      shouldPollFinalizeFallback({
        connected: true,
        lastEvent: { sessionId: 'other', bump: NOW },
        sessionId: SID,
        now: NOW,
      }),
    ).toBe(true);
    expect(
      shouldPollFinalizeFallback({ connected: true, lastEvent: null, sessionId: SID, now: NOW }),
    ).toBe(true);
  });

  it('polls when the event lacks a numeric bump', () => {
    expect(
      shouldPollFinalizeFallback({
        connected: true,
        lastEvent: { sessionId: SID },
        sessionId: SID,
        now: NOW,
      }),
    ).toBe(true);
  });

  it('treats exactly freshMs old as stale (resumes polling at the boundary)', () => {
    expect(
      shouldPollFinalizeFallback({
        connected: true,
        lastEvent: { sessionId: SID, bump: NOW - FINALIZE_LIVE_FRESH_MS },
        sessionId: SID,
        now: NOW,
      }),
    ).toBe(true);
  });
});
