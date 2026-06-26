import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FinalizeRunRow, RouteDeps, SessionRow } from '../types.js';

// Regression for the autonomous premature-Finalize bug: a turn that ended in
// an upstream API error (e.g. "API Error: The socket connection was closed
// unexpectedly") used to look like a successful turn end, so sessions with
// finalize_automation review/push/merge auto-started Finalize on a
// half-finished worktree — and at level `merge`, incomplete code could land
// on main unseen. The fix records the error in `sessions.last_turn_error`;
// these tests pin the fail-closed gate in the automation runner.

const startFinalizeRunBackground = vi.fn(async () => ({ ok: true }));
vi.mock('./trigger-run.js', () => ({
  startFinalizeRunBackground: () => startFinalizeRunBackground(),
}));
const runFinalizePush = vi.fn(async () => ({ ok: true, prUrl: 'https://pr' }));
vi.mock('./push-run.js', () => ({ runFinalizePush: () => runFinalizePush() }));
vi.mock('./ensure-kanban-card.js', () => ({
  ensureKanbanCardForSession: () => ({ card: { id: 'c1' } }),
}));
vi.mock('./automation.js', () => ({
  resolveSessionFinalizeAutomation: () => 'merge',
  shouldAutoStartFinalize: () => true,
  shouldAutoPushAfterReady: () => true,
  shouldEnableAutoMergeForAutomation: () => false,
}));
vi.mock('./worktree-changes.js', () => ({
  getSessionCommittableChanges: async () => ({ ok: true }),
}));

import {
  maybeAutoStartFinalizeForSession,
  maybeAutoPushReadyFinalizeRun,
  setFinalizeAutomationRouteDeps,
} from './automation-runner.js';

function makeSession(overrides: Partial<SessionRow>): SessionRow {
  return {
    id: 's1',
    agent_id: 'a1',
    worktree_path: '/wt',
    last_turn_error: null,
    // Autonomous/assigned session — only these auto-fire Finalize.
    auto_ship_on_complete: 1,
    ...overrides,
  } as unknown as SessionRow;
}

function wireRouteDeps(session: SessionRow, run?: Partial<FinalizeRunRow>): void {
  setFinalizeAutomationRouteDeps({
    stmts: {
      getSession: { get: () => session },
      getLatestFinalizeRunForSession: { get: () => undefined },
      getPushedFinalizeRunForSession: { get: () => undefined },
      getFinalizeRun: {
        get: () =>
          ({
            id: 'run1',
            status: 'ready_to_push',
            flake_recovered_jobs: null,
            ...run,
          }) as FinalizeRunRow,
      },
    },
    findAgent: () => ({ project: { id: 'p1' } }),
    broadcast: vi.fn(),
    config: {},
  } as unknown as RouteDeps);
}

describe('finalize automation — last_turn_error gate', () => {
  beforeEach(() => {
    startFinalizeRunBackground.mockClear();
    runFinalizePush.mockClear();
  });

  it('blocks auto-start when the last turn ended in an error', async () => {
    wireRouteDeps(
      makeSession({
        last_turn_error: 'API Error: The socket connection was closed unexpectedly',
      }),
    );
    await maybeAutoStartFinalizeForSession('s1');
    expect(startFinalizeRunBackground).not.toHaveBeenCalled();
  });

  it('auto-starts normally when the last turn was clean', async () => {
    wireRouteDeps(makeSession({ last_turn_error: null }));
    await maybeAutoStartFinalizeForSession('s1');
    expect(startFinalizeRunBackground).toHaveBeenCalledTimes(1);
  });

  it('blocks auto-push of a parked ready_to_push run after an errored turn', async () => {
    wireRouteDeps(makeSession({ last_turn_error: 'claude-code exited with code 1' }));
    await maybeAutoPushReadyFinalizeRun({ sessionId: 's1', runId: 'run1' });
    expect(runFinalizePush).not.toHaveBeenCalled();
  });

  it('auto-pushes normally when the last turn was clean', async () => {
    wireRouteDeps(makeSession({ last_turn_error: null }));
    await maybeAutoPushReadyFinalizeRun({ sessionId: 's1', runId: 'run1' });
    expect(runFinalizePush).toHaveBeenCalledTimes(1);
  });
});
