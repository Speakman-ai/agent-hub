import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FinalizeRunRow, KanbanCardRow, RouteDeps, SessionRow } from '../types.js';

// Regression: interactive (human-driven) sessions must NOT auto-start Finalize
// or auto-push/auto-merge, even when the per-session automation dropdown is set
// to "Build and Review" / "Build and Push" / "Auto Merge". Only autonomous /
// kanban-assigned sessions (auto_ship_on_complete=1 or the linked card's
// dispatched_by_autonomous=1) auto-fire. This pins the seam that turns off the
// trigger "when you click auto merge or build and push" for interactive
// sessions while keeping autonomous auto-merge intact.

const startFinalizeRunBackground = vi.fn(async () => ({ ok: true }));
vi.mock('./trigger-run.js', () => ({
  startFinalizeRunBackground: () => startFinalizeRunBackground(),
}));
const runFinalizePush = vi.fn(async () => ({ ok: true, prUrl: 'https://pr' }));
vi.mock('./push-run.js', () => ({ runFinalizePush: () => runFinalizePush() }));

// The card surfaced for the session — controls the dispatched_by_autonomous arm
// of shouldAutoShipSessionAtEnd. Mutated per test.
let mockCard: Partial<KanbanCardRow> = { id: 'c1' };
vi.mock('./ensure-kanban-card.js', () => ({
  ensureKanbanCardForSession: () => ({ card: mockCard }),
}));

// Force levels that WOULD auto-fire if the session were allowed to — so the
// only thing under test is the interactive-vs-autonomous gate.
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
    auto_ship_on_complete: 0,
    ...overrides,
  } as unknown as SessionRow;
}

function wireRouteDeps(session: SessionRow): void {
  setFinalizeAutomationRouteDeps({
    stmts: {
      getSession: { get: () => session },
      getLatestFinalizeRunForSession: { get: () => undefined },
      getFinalizeRun: {
        get: () =>
          ({ id: 'run1', status: 'ready_to_push', flake_recovered_jobs: null }) as FinalizeRunRow,
      },
    },
    findAgent: () => ({ project: { id: 'p1' } }),
    broadcast: vi.fn(),
    config: {},
  } as unknown as RouteDeps);
}

describe('finalize automation — interactive-session gate', () => {
  beforeEach(() => {
    startFinalizeRunBackground.mockClear();
    runFinalizePush.mockClear();
    mockCard = { id: 'c1' };
  });

  it('does NOT auto-start Finalize for an interactive session', async () => {
    wireRouteDeps(makeSession({ auto_ship_on_complete: 0 }));
    await maybeAutoStartFinalizeForSession('s1');
    expect(startFinalizeRunBackground).not.toHaveBeenCalled();
  });

  it('does NOT auto-push a ready_to_push run for an interactive session', async () => {
    wireRouteDeps(makeSession({ auto_ship_on_complete: 0 }));
    await maybeAutoPushReadyFinalizeRun({ sessionId: 's1', runId: 'run1' });
    expect(runFinalizePush).not.toHaveBeenCalled();
  });

  it('auto-starts for an autonomous-assigned session (auto_ship_on_complete=1)', async () => {
    wireRouteDeps(makeSession({ auto_ship_on_complete: 1 }));
    await maybeAutoStartFinalizeForSession('s1');
    expect(startFinalizeRunBackground).toHaveBeenCalledTimes(1);
  });

  it('auto-pushes for an autonomous-assigned session (auto_ship_on_complete=1)', async () => {
    wireRouteDeps(makeSession({ auto_ship_on_complete: 1 }));
    await maybeAutoPushReadyFinalizeRun({ sessionId: 's1', runId: 'run1' });
    expect(runFinalizePush).toHaveBeenCalledTimes(1);
  });

  it('auto-starts when the linked card was dispatched by the autonomous loop', async () => {
    mockCard = { id: 'c1', dispatched_by_autonomous: 1 };
    wireRouteDeps(makeSession({ auto_ship_on_complete: 0 }));
    await maybeAutoStartFinalizeForSession('s1');
    expect(startFinalizeRunBackground).toHaveBeenCalledTimes(1);
  });
});
