import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FinalizeRunRow, KanbanCardRow, RouteDeps, SessionRow } from '../types.js';

// Regression: the per-session automation level alone drives end-of-turn
// auto-fire. Setting the dropdown to "Build and Review" / "Build and Push" /
// "Auto Merge" is an explicit per-session opt-in that is honored at the end of
// the turn for INTERACTIVE (human-driven) sessions just as it is for
// autonomous / kanban-assigned ones. There is no interactive-vs-autonomous
// gate: a session a human is driving and switches to Automerge mid-session must
// auto-start (and auto-push/auto-merge) when its turn ends.
//
// Pairs with automation-runner-turn-error.test.ts (errored turns still block)
// and routes/sessions-finalize-automation-patch.test.ts (changing the dropdown
// does NOT itself start a run).

const startFinalizeRunBackground = vi.fn(async () => ({ ok: true }));
vi.mock('./trigger-run.js', () => ({
  startFinalizeRunBackground: () => startFinalizeRunBackground(),
}));
const runFinalizePush = vi.fn(async () => ({ ok: true, prUrl: 'https://pr' }));
vi.mock('./push-run.js', () => ({ runFinalizePush: () => runFinalizePush() }));

let mockCard: Partial<KanbanCardRow> = { id: 'c1' };
vi.mock('./ensure-kanban-card.js', () => ({
  ensureKanbanCardForSession: () => ({ card: mockCard }),
}));

// Level resolves to "merge" so auto-start AND auto-push fire when allowed —
// the only thing under test is that nothing gates them on interactive-ness.
vi.mock('./automation.js', () => ({
  resolveSessionFinalizeAutomation: () => 'merge',
  shouldAutoStartFinalize: () => true,
  shouldAutoPushAfterReady: () => true,
  shouldEnableAutoMergeForAutomation: () => false,
}));

/** Mutable so the TOCTOU test can flip the pushed row mid-probe. */
let onCommittableProbe: (() => void) | null = null;
const getSessionCommittableChanges = vi.fn(async () => {
  onCommittableProbe?.();
  return { ok: true as const };
});
vi.mock('./worktree-changes.js', () => ({
  getSessionCommittableChanges: (...args: unknown[]) => getSessionCommittableChanges(...args),
}));
vi.mock('../session-worktree-io.js', () => ({
  sessionWorktreeIoFor: async () => ({}),
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

function wireRouteDeps(session: SessionRow, pushedRun?: Partial<FinalizeRunRow>): void {
  setFinalizeAutomationRouteDeps({
    stmts: {
      getSession: { get: () => session },
      getLatestFinalizeRunForSession: { get: () => undefined },
      getPushedFinalizeRunForSession: {
        get: () => (pushedRun ? ({ id: 'pushed', ...pushedRun } as FinalizeRunRow) : undefined),
      },
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

describe('finalize automation — level drives end-of-turn auto-fire', () => {
  beforeEach(() => {
    startFinalizeRunBackground.mockClear();
    runFinalizePush.mockClear();
    getSessionCommittableChanges.mockClear();
    onCommittableProbe = null;
    mockCard = { id: 'c1' };
  });

  it('auto-starts Finalize for an interactive session when the level allows it', async () => {
    wireRouteDeps(makeSession({ auto_ship_on_complete: 0 }));
    await maybeAutoStartFinalizeForSession('s1');
    expect(startFinalizeRunBackground).toHaveBeenCalledTimes(1);
  });

  it('auto-pushes a ready_to_push run for an interactive session when the level allows it', async () => {
    wireRouteDeps(makeSession({ auto_ship_on_complete: 0 }));
    await maybeAutoPushReadyFinalizeRun({ sessionId: 's1', runId: 'run1' });
    expect(runFinalizePush).toHaveBeenCalledTimes(1);
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

  it('does not auto-start after the session has pushed through Finalize', async () => {
    wireRouteDeps(makeSession({ auto_ship_on_complete: 1 }), { status: 'pushed' });
    await maybeAutoStartFinalizeForSession('s1');
    expect(startFinalizeRunBackground).not.toHaveBeenCalled();
  });

  it('does not auto-push after the session has pushed through Finalize', async () => {
    wireRouteDeps(makeSession({ auto_ship_on_complete: 1 }), { status: 'pushed' });
    await maybeAutoPushReadyFinalizeRun({ sessionId: 's1', runId: 'run1' });
    expect(runFinalizePush).not.toHaveBeenCalled();
  });

  it('does not auto-start when push lands during the post-entry worktree probe (TOCTOU)', async () => {
    // Mirrors ryan-portfolio session 4e18eec9: end-of-turn auto-start overlapped
    // the first run's push. Entry hasPushed was false; by the time kickoff would
    // run, a pushed row existed — must not open a new agent_block attempt.
    const session = makeSession({ auto_ship_on_complete: 1 });
    let pushed: FinalizeRunRow | undefined;
    onCommittableProbe = () => {
      pushed = { id: 'pushed', status: 'pushed' } as FinalizeRunRow;
    };
    setFinalizeAutomationRouteDeps({
      stmts: {
        getSession: { get: () => session },
        getLatestFinalizeRunForSession: {
          get: () => pushed ?? ({ id: 'run-inflight', status: 'running_checks' } as FinalizeRunRow),
        },
        getPushedFinalizeRunForSession: { get: () => pushed },
        getFinalizeRun: { get: () => undefined },
      },
      findAgent: () => ({ project: { id: 'p1' } }),
      broadcast: vi.fn(),
      config: {},
    } as unknown as RouteDeps);

    await maybeAutoStartFinalizeForSession('s1');
    expect(getSessionCommittableChanges).toHaveBeenCalled();
    expect(startFinalizeRunBackground).not.toHaveBeenCalled();
  });
});
