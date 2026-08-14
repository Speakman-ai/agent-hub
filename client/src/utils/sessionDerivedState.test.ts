import { describe, it, expect } from 'vitest';
import {
  isSessionConsultModeEnabled,
  isSessionWorktreeEnabled,
  isSessionWorkspaceReady,
  shouldShowSessionChangesButton,
  shouldEnsureSessionWorkspaceOnOpen,
  isSessionComposerWorkspaceReady,
  planWorkspaceEnsureOnOpen,
  withoutSessionKey,
  prependSessionDeduped,
  planCreatedSessionCaches,
} from './sessionDerivedState';

describe('sessionDerivedState', () => {
  describe('isSessionConsultModeEnabled', () => {
    it('returns false when session is undefined (missing row must not imply consult mode)', () => {
      expect(isSessionConsultModeEnabled(undefined)).toBe(false);
    });

    it('returns false when session is null', () => {
      expect(isSessionConsultModeEnabled(null)).toBe(false);
    });

    it('returns false for chat mode with ask_mode off', () => {
      expect(isSessionConsultModeEnabled({ id: 'x', ask_mode: 0 })).toBe(false);
      expect(isSessionConsultModeEnabled({ id: 'x' })).toBe(false);
      expect(isSessionConsultModeEnabled({ id: 'x', session_mode: 'chat', ask_mode: 0 })).toBe(
        false,
      );
    });

    it('returns true for consult session_mode', () => {
      expect(isSessionConsultModeEnabled({ id: 'x', session_mode: 'consult' })).toBe(true);
    });

    it('returns true for legacy ask_mode rows', () => {
      expect(isSessionConsultModeEnabled({ id: 'x', ask_mode: 1 })).toBe(true);
    });
  });

  describe('isSessionWorktreeEnabled', () => {
    it('defaults to enabled when session is undefined (matches server default)', () => {
      expect(isSessionWorktreeEnabled(undefined)).toBe(true);
    });

    it('returns false when use_worktree is 0', () => {
      expect(isSessionWorktreeEnabled({ id: 'x', use_worktree: 0 })).toBe(false);
    });

    it('returns true when use_worktree is 1 or missing on a row object', () => {
      expect(isSessionWorktreeEnabled({ id: 'x', use_worktree: 1 })).toBe(true);
      expect(isSessionWorktreeEnabled({ id: 'x' })).toBe(true);
    });
  });

  describe('isSessionWorkspaceReady', () => {
    it('is true when worktree is disabled', () => {
      expect(isSessionWorkspaceReady({ id: 'x', use_worktree: 0, worktree_path: null })).toBe(true);
    });

    it('is false when worktree is enabled but path is empty', () => {
      expect(isSessionWorkspaceReady({ id: 'x', use_worktree: 1, worktree_path: null })).toBe(
        false,
      );
      expect(isSessionWorkspaceReady({ id: 'x', use_worktree: 1, worktree_path: '  ' })).toBe(
        false,
      );
    });

    it('is true when worktree_path is set', () => {
      expect(
        isSessionWorkspaceReady({
          id: 'x',
          use_worktree: 1,
          worktree_path: '/wt/session-abc',
        }),
      ).toBe(true);
    });
  });

  describe('shouldEnsureSessionWorkspaceOnOpen', () => {
    it('returns false when there is no active session', () => {
      expect(shouldEnsureSessionWorkspaceOnOpen(undefined)).toBe(false);
      expect(shouldEnsureSessionWorkspaceOnOpen(null)).toBe(false);
    });

    it('returns false for a non-worktree (spike / workflow) session', () => {
      expect(shouldEnsureSessionWorkspaceOnOpen({ id: 'x', use_worktree: 0 })).toBe(false);
    });

    it('returns true for a fresh worktree session with no clone yet', () => {
      expect(
        shouldEnsureSessionWorkspaceOnOpen({ id: 'x', use_worktree: 1, worktree_path: null }),
      ).toBe(true);
    });

    it('returns true for an already-cloned worktree whose live env may be gone (regression)', () => {
      // A persisted worktree_path used to short-circuit the open-time ensure
      // (via isSessionWorkspaceReady), so reopening a session after a Hub
      // restart / idle reap skipped the VM reboot and the first chat paid the
      // boot delay. The ensure must still fire for an already-cloned session.
      expect(isSessionWorkspaceReady({ id: 'x', use_worktree: 1, worktree_path: '/wt/abc' })).toBe(
        true,
      );
      expect(
        shouldEnsureSessionWorkspaceOnOpen({ id: 'x', use_worktree: 1, worktree_path: '/wt/abc' }),
      ).toBe(true);
    });
  });

  describe('isSessionComposerWorkspaceReady', () => {
    it('is ready when the session does not need an open-time ensure', () => {
      expect(isSessionComposerWorkspaceReady({ needsEnsure: false, settled: false })).toBe(true);
    });

    it('is not ready while a needed ensure is still pending (first-render gate)', () => {
      expect(isSessionComposerWorkspaceReady({ needsEnsure: true, settled: false })).toBe(false);
    });

    it('becomes ready once the ensure settles (resolved or failed)', () => {
      expect(isSessionComposerWorkspaceReady({ needsEnsure: true, settled: true })).toBe(true);
    });
  });

  describe('withoutSessionKey', () => {
    it('returns the same map reference when the key is absent', () => {
      const map = { a: true };
      expect(withoutSessionKey(map, 'b')).toBe(map);
      expect(withoutSessionKey(map, undefined)).toBe(map);
      expect(withoutSessionKey(map, null)).toBe(map);
    });

    it('removes the key immutably when present', () => {
      const map = { a: true, b: true };
      const next = withoutSessionKey(map, 'a');
      expect(next).not.toBe(map);
      expect(next).toEqual({ b: true });
      expect(map).toEqual({ a: true, b: true });
    });
  });

  describe('planWorkspaceEnsureOnOpen', () => {
    it('skips when this activation already registered an attempt', () => {
      expect(planWorkspaceEnsureOnOpen({ attempted: true, inFlight: false })).toBe('skip');
      expect(planWorkspaceEnsureOnOpen({ attempted: true, inFlight: true })).toBe('skip');
    });

    it('adopts an in-flight request instead of double-posting', () => {
      expect(planWorkspaceEnsureOnOpen({ attempted: false, inFlight: true })).toBe('adopt');
    });

    it('issues a fresh request when nothing is in flight', () => {
      expect(planWorkspaceEnsureOnOpen({ attempted: false, inFlight: false })).toBe('issue');
    });
  });

  describe('per-activation reset on leave (regression: idle-reaped VM on reopen)', () => {
    it('re-ensures and re-gates the composer when a session is reopened after leaving', () => {
      const session = { id: 's1', use_worktree: 1, worktree_path: '/wt/s1' };

      // First open: the effect fired and settled.
      const attempted = new Set<string>(['s1']);
      let settled: Record<string, any> = { s1: true };
      expect(
        isSessionComposerWorkspaceReady({
          needsEnsure: shouldEnsureSessionWorkspaceOnOpen(session),
          settled: !!settled.s1,
        }),
      ).toBe(true);

      // Leave s1 (effect cleanup): clear attempted + settled so readiness is
      // modeled per activation, not once per browser lifetime.
      attempted.delete('s1');
      settled = withoutSessionKey(settled, 's1');

      // Reopen s1 (its VM may have been idle-reaped meanwhile): the ensure must
      // re-fire and the composer must be gated until the fresh ensure settles.
      expect(attempted.has('s1')).toBe(false);
      expect(shouldEnsureSessionWorkspaceOnOpen(session)).toBe(true);
      expect(
        isSessionComposerWorkspaceReady({
          needsEnsure: shouldEnsureSessionWorkspaceOnOpen(session),
          settled: !!settled.s1,
        }),
      ).toBe(false);
    });

    it('adopts the in-flight ensure on reopen so the composer is not permanently gated', () => {
      // Reproduces the deadlock: leaving mid-request clears `attempted`, and a
      // reopen that only checked in-flight would skip a new request while the
      // old request refused to settle — stranding the composer gated forever.
      const attempted = new Set<string>();
      const inFlight = new Set<string>();
      let settled: Record<string, any> = {};

      // Mirror the effect's open handling.
      const open = (sid: string) => {
        const plan = planWorkspaceEnsureOnOpen({
          attempted: attempted.has(sid),
          inFlight: inFlight.has(sid),
        });
        if (plan === 'skip') return plan;
        attempted.add(sid);
        if (plan === 'adopt') return plan;
        inFlight.add(sid);
        return plan;
      };
      const leave = (sid: string) => {
        attempted.delete(sid);
        settled = withoutSessionKey(settled, sid);
      };
      // Mirror the request's `.finally`.
      const settleRequest = (sid: string) => {
        inFlight.delete(sid);
        if (attempted.has(sid)) {
          settled = settled[sid] ? settled : { ...settled, [sid]: true };
        }
      };

      // Open s1 → issues a single request.
      expect(open('s1')).toBe('issue');
      expect(inFlight.has('s1')).toBe(true);

      // Leave while the request is still in flight.
      leave('s1');
      expect(attempted.has('s1')).toBe(false);

      // Reopen while still in flight → adopt (re-registers the attempt, no
      // second request).
      expect(open('s1')).toBe('adopt');
      expect(attempted.has('s1')).toBe(true);
      expect(inFlight.size).toBe(1);

      // The single request settles → marks the reopened activation ready.
      settleRequest('s1');
      expect(settled.s1).toBe(true);
      expect(isSessionComposerWorkspaceReady({ needsEnsure: true, settled: !!settled.s1 })).toBe(
        true,
      );
    });

    it('keeps the composer gated on a failed ensure and re-enables it after a successful retry', () => {
      // A failed workspace/environment ensure must NOT be recorded as settled
      // (which would enable the composer against a VM that is not ready). It is
      // tracked as an error instead, and a retry path re-issues the ensure.
      const attempted = new Set<string>();
      const inFlight = new Set<string>();
      let settled: Record<string, any> = {};
      let error: Record<string, any> = {};

      const open = (sid: string) => {
        const plan = planWorkspaceEnsureOnOpen({
          attempted: attempted.has(sid),
          inFlight: inFlight.has(sid),
        });
        if (plan === 'skip') return plan;
        attempted.add(sid);
        error = withoutSessionKey(error, sid);
        if (plan === 'adopt') return plan;
        inFlight.add(sid);
        return plan;
      };
      // Mirror the runner's success (`.then`) and failure (`.catch`) handlers.
      const resolveOk = (sid: string) => {
        inFlight.delete(sid);
        if (attempted.has(sid)) settled = settled[sid] ? settled : { ...settled, [sid]: true };
      };
      const resolveFail = (sid: string, msg: string) => {
        inFlight.delete(sid);
        if (attempted.has(sid)) error = { ...error, [sid]: msg };
      };
      const retry = (sid: string) => {
        attempted.delete(sid);
        error = withoutSessionKey(error, sid);
        open(sid);
      };

      // Open s1, the ensure fails.
      open('s1');
      resolveFail('s1', 'boot failed');
      // Failure is NOT settled — composer stays gated — and an error is surfaced.
      expect(settled.s1).toBeUndefined();
      expect(error.s1).toBe('boot failed');
      expect(isSessionComposerWorkspaceReady({ needsEnsure: true, settled: !!settled.s1 })).toBe(
        false,
      );

      // Retry issues a fresh request (error cleared) and this time succeeds.
      retry('s1');
      expect(error.s1).toBeUndefined();
      expect(inFlight.has('s1')).toBe(true);
      resolveOk('s1');
      expect(settled.s1).toBe(true);
      expect(isSessionComposerWorkspaceReady({ needsEnsure: true, settled: !!settled.s1 })).toBe(
        true,
      );
    });

    it('re-ensures and re-gates after a WebSocket disconnect (Hub restart drops the VM)', () => {
      const attempted = new Set<string>();
      const inFlight = new Set<string>();
      let settled: Record<string, any> = {};
      let error: Record<string, any> = {};

      const open = (sid: string) => {
        const plan = planWorkspaceEnsureOnOpen({
          attempted: attempted.has(sid),
          inFlight: inFlight.has(sid),
        });
        if (plan === 'skip') return plan;
        attempted.add(sid);
        error = withoutSessionKey(error, sid);
        if (plan === 'adopt') return plan;
        inFlight.add(sid);
        return plan;
      };
      const resolveOk = (sid: string) => {
        inFlight.delete(sid);
        if (attempted.has(sid)) settled = settled[sid] ? settled : { ...settled, [sid]: true };
      };
      // Mirror the on-disconnect invalidation.
      const disconnect = () => {
        attempted.clear();
        settled = {};
        error = {};
      };

      // Open s1 and reach ready.
      open('s1');
      resolveOk('s1');
      expect(isSessionComposerWorkspaceReady({ needsEnsure: true, settled: !!settled.s1 })).toBe(
        true,
      );

      // WS drops (Hub restart) — readiness must be invalidated so the composer
      // re-gates even though the same session stays active.
      disconnect();
      expect(attempted.has('s1')).toBe(false);
      expect(isSessionComposerWorkspaceReady({ needsEnsure: true, settled: !!settled.s1 })).toBe(
        false,
      );

      // On reconnect the ensure effect re-runs and issues a fresh request
      // (not 'skip') that re-gates until it settles.
      expect(open('s1')).toBe('issue');
      expect(isSessionComposerWorkspaceReady({ needsEnsure: true, settled: !!settled.s1 })).toBe(
        false,
      );
      resolveOk('s1');
      expect(isSessionComposerWorkspaceReady({ needsEnsure: true, settled: !!settled.s1 })).toBe(
        true,
      );
    });
  });

  describe('shouldShowSessionChangesButton', () => {
    it('shows for a normal (non-consult) worktree session', () => {
      expect(
        shouldShowSessionChangesButton({
          isWorkflowProject: false,
          consultActive: false,
          session: { id: 'x', use_worktree: 1 },
        }),
      ).toBe(true);
    });

    it('still shows for a consult session that has a worktree (the pushed-then-consult case)', () => {
      // Regression: a session that ships flips to Consult ("Pushed to Agent Hub")
      // but its diff must stay inspectable.
      expect(
        shouldShowSessionChangesButton({
          isWorkflowProject: false,
          consultActive: true,
          session: { id: 'x', session_mode: 'consult', use_worktree: 1 },
        }),
      ).toBe(true);
    });

    it('hides for a consult session with no worktree (nothing to diff)', () => {
      expect(
        shouldShowSessionChangesButton({
          isWorkflowProject: false,
          consultActive: true,
          session: { id: 'x', session_mode: 'consult', use_worktree: 0 },
        }),
      ).toBe(false);
    });

    it('never shows on a workflow (no-code) project', () => {
      expect(
        shouldShowSessionChangesButton({
          isWorkflowProject: true,
          consultActive: false,
          session: { id: 'x', use_worktree: 1 },
        }),
      ).toBe(false);
    });
  });

  describe('prependSessionDeduped', () => {
    const a = { id: 'a', name: 'One' };
    const b = { id: 'b', name: 'Two' };

    it('prepends when the id is new', () => {
      expect(prependSessionDeduped([b], a)).toEqual([a, b]);
    });

    it('returns the same array reference when the id already exists', () => {
      const prev = [a, b];
      expect(prependSessionDeduped(prev, { ...a, name: 'Renamed' })).toBe(prev);
    });

    it('ignores a session without id', () => {
      const prev = [a];
      expect(prependSessionDeduped(prev, {})).toBe(prev);
    });
  });

  describe('planCreatedSessionCaches', () => {
    const rowA = { id: 's-a' };
    const created = { id: 's-new' };

    it('caches the new session under the target agent without touching another agent', () => {
      // Creating a session for agent-2 while agent-1 is the loaded list must NOT
      // prepend the row onto agent-1's `sessions` (which would later be cached
      // under agent-1 — cross-agent pollution).
      const sessions = [rowA];
      const out = planCreatedSessionCaches({
        targetAgentId: 'agent-2',
        loadedSessionsAgentId: 'agent-1',
        session: created,
        sessionsByAgentId: { 'agent-1': [rowA] },
        sessions,
      });
      // agent-2's cache gains the new row.
      expect(out.sessionsByAgentId['agent-2']).toEqual([created]);
      // agent-1's cache entry is untouched.
      expect(out.sessionsByAgentId['agent-1']).toEqual([rowA]);
      // The live `sessions` array is returned by the SAME reference (no mutate).
      expect(out.sessions).toBe(sessions);
    });

    it('returns the SAME `sessions` reference when the list is not the target agent (no re-render)', () => {
      const sessions = [rowA];
      const out = planCreatedSessionCaches({
        targetAgentId: 'agent-2',
        loadedSessionsAgentId: 'agent-1',
        session: created,
        sessionsByAgentId: {},
        sessions,
      });
      expect(out.sessions).toBe(sessions);
    });

    it('updates the live `sessions` only when it belongs to the target agent', () => {
      const out = planCreatedSessionCaches({
        targetAgentId: 'agent-1',
        loadedSessionsAgentId: 'agent-1',
        session: created,
        sessionsByAgentId: { 'agent-1': [rowA] },
        sessions: [rowA],
      });
      expect(out.sessions).toEqual([created, rowA]);
      expect(out.sessionsByAgentId['agent-1']).toEqual([created, rowA]);
    });

    it('is a no-op for a missing agent id or session', () => {
      const state = { sessionsByAgentId: { x: [rowA] }, sessions: [rowA] };
      expect(
        planCreatedSessionCaches({
          targetAgentId: '',
          loadedSessionsAgentId: 'x',
          session: created,
          ...state,
        }),
      ).toEqual(state);
      expect(
        planCreatedSessionCaches({
          targetAgentId: 'x',
          loadedSessionsAgentId: 'x',
          session: {},
          ...state,
        }),
      ).toEqual(state);
    });
  });
});
