import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FinalizeRunRow, RouteDeps } from '../types.js';
import {
  serializeFlakeGate,
  gateResultFromVerdicts,
  blockedGateResult,
  type JobFlakeVerdict,
} from './flake-recovery.js';

// Mock the collaborators maybeAutoPushReadyFinalizeRun reaches so we can
// assert ONLY on whether the push fires.
const runFinalizePush = vi.fn(async () => ({ ok: true, prUrl: 'https://pr' }));
vi.mock('./push-run.js', () => ({ runFinalizePush: () => runFinalizePush() }));
vi.mock('./ensure-kanban-card.js', () => ({
  ensureKanbanCardForSession: () => ({ card: { id: 'c1' } }),
}));
vi.mock('./automation.js', () => ({
  resolveSessionFinalizeAutomation: () => 'push',
  shouldAutoPushAfterReady: () => true,
  shouldAutoStartFinalize: () => false,
  shouldEnableAutoMergeForAutomation: () => false,
}));

import {
  maybeAutoPushReadyFinalizeRun,
  setFinalizeAutomationRouteDeps,
} from './automation-runner.js';

const FLAKE: JobFlakeVerdict = {
  jobId: 'e2e',
  matrixKey: '',
  classification: 'flake_recovered',
  failedRounds: [1],
  passedRound: 2,
  failureCount: 1,
};

function makeRun(overrides: Partial<FinalizeRunRow>): FinalizeRunRow {
  return {
    id: 'run1',
    status: 'ready_to_push',
    flake_recovered_jobs: null,
    ...overrides,
  } as unknown as FinalizeRunRow;
}

function wireRouteDeps(run: FinalizeRunRow): void {
  setFinalizeAutomationRouteDeps({
    stmts: {
      getSession: {
        // Autonomous/assigned session — only these auto-fire Finalize.
        get: () => ({ id: 's1', agent_id: 'a1', worktree_path: '/wt', auto_ship_on_complete: 1 }),
      },
      getFinalizeRun: { get: () => run },
    },
    findAgent: () => ({ project: { id: 'p1' } }),
    broadcast: vi.fn(),
    config: {},
  } as unknown as RouteDeps);
}

describe('maybeAutoPushReadyFinalizeRun — flake gate', () => {
  beforeEach(() => {
    runFinalizePush.mockClear();
  });

  it('blocks auto-push when the run has flake-recovered jobs', async () => {
    wireRouteDeps(
      makeRun({ flake_recovered_jobs: serializeFlakeGate(gateResultFromVerdicts([FLAKE])) }),
    );
    await maybeAutoPushReadyFinalizeRun({ sessionId: 's1', runId: 'run1' });
    expect(runFinalizePush).not.toHaveBeenCalled();
  });

  it('blocks auto-push when the gate is blocked (fail-closed, no verdicts)', async () => {
    wireRouteDeps(
      makeRun({ flake_recovered_jobs: serializeFlakeGate(blockedGateResult('history missing')) }),
    );
    await maybeAutoPushReadyFinalizeRun({ sessionId: 's1', runId: 'run1' });
    expect(runFinalizePush).not.toHaveBeenCalled();
  });

  it('blocks auto-push when the column is non-NULL but unparseable (fail-closed)', async () => {
    wireRouteDeps(makeRun({ flake_recovered_jobs: 'not json' }));
    await maybeAutoPushReadyFinalizeRun({ sessionId: 's1', runId: 'run1' });
    expect(runFinalizePush).not.toHaveBeenCalled();
  });

  it('auto-pushes a clean run (gate column NULL)', async () => {
    wireRouteDeps(makeRun({ flake_recovered_jobs: null }));
    await maybeAutoPushReadyFinalizeRun({ sessionId: 's1', runId: 'run1' });
    expect(runFinalizePush).toHaveBeenCalledTimes(1);
  });
});
