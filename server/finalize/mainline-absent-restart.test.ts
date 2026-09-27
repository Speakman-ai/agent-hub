/**
 * Owed Finalize restart after a mainline push was found absent. The push and
 * kickoff collaborators are mocked; the reconciler that drives the retry runs
 * against the real session row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinalizeRunRow, RouteDeps } from '../types.js';

const runFinalizePush = vi.fn();
const startFinalizeRunBackground = vi.fn();
const acquirePushLock = vi.fn();

vi.mock('./push-run.js', () => ({
  runFinalizePush: (...args: unknown[]) => runFinalizePush(...args),
}));
vi.mock('./trigger-run.js', () => ({
  startFinalizeRunBackground: (...args: unknown[]) => startFinalizeRunBackground(...args),
}));
vi.mock('./push-lock.js', () => ({
  acquirePushLock: (...args: unknown[]) => acquirePushLock(...args),
}));
vi.mock('./resolve-base-branch.js', () => ({
  resolveFinalizeBaseBranchForCard: async () => 'main',
  resolveFinalizeGateBase: () => 'main',
}));
vi.mock('./ensure-kanban-card.js', () => ({
  ensureKanbanCardForSession: () => ({ card: { id: 'c1' } }),
}));
vi.mock('./post-push-session-lock.js', () => ({
  sessionAllowsRepeatFinalizePush: () => true,
  sessionIsLockedAfterFinalizePush: () => false,
}));
vi.mock('./automation.js', () => ({
  resolveSessionFinalizeAutomation: () => 'merge',
  shouldAutoPushAfterReady: () => true,
  shouldAutoStartFinalize: () => true,
  shouldEnableAutoMergeForAutomation: () => false,
}));
vi.mock('../session-autopilot.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../session-autopilot.js')>()),
  enforceAutopilotExpiry: () => ({ blocked: false }),
}));
vi.mock('../session-mode.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../session-mode.js')>()),
  isAutopilotModeActive: () => true,
}));

import {
  decideMainlineAbsentRestart,
  restartFinalizeAfterMainlineAbsent,
  restartResultFromAutoPush,
  setFinalizeAutomationRouteDeps,
} from './automation-runner.js';
import {
  createMainlineReconciler,
  mainlineReconcileBackoffMs,
} from '../autopilot-mainline-reconciler.js';
import { getDb, getStmts } from '../db.js';
import {
  type AutopilotSessionConfig,
  parseAutopilotSessionConfig,
} from '../../shared/utils/sessionAutopilot.js';
import { idleMainlineSlot } from '../../shared/utils/autopilotMainlineSlot.js';

const SESSION = 's-restart';
const SHA = 'b'.repeat(40);

function run(id: string, status: string): FinalizeRunRow {
  return { id, status, flake_recovered_jobs: null } as unknown as FinalizeRunRow;
}

/** Finalize run rows keyed by id; `latest` is what the session reports. */
const runs = new Map<string, FinalizeRunRow>();
let latestId: string | null = null;

function wire(): void {
  setFinalizeAutomationRouteDeps({
    stmts: {
      getSession: {
        get: () => ({ id: SESSION, agent_id: 'a1', worktree_path: '/wt', last_turn_error: null }),
      },
      getLatestFinalizeRunForSession: { get: () => (latestId ? runs.get(latestId) : undefined) },
      getFinalizeRun: { get: (id: string) => runs.get(id) },
      getKanbanEpic: { get: () => undefined },
    },
    findAgent: () => ({ project: { id: 'p1' } }),
    broadcast: vi.fn(),
    config: {},
  } as unknown as RouteDeps);
}

beforeEach(() => {
  runs.clear();
  latestId = null;
  runFinalizePush.mockReset();
  startFinalizeRunBackground.mockReset();
  acquirePushLock.mockReset();
  acquirePushLock.mockResolvedValue({ ok: true, handle: { release: () => {} } });
  wire();
});

describe('decideMainlineAbsentRestart', () => {
  it('starts fresh after the uncertain run failed, a restart swept it, or there is no run', () => {
    expect(decideMainlineAbsentRestart({ status: 'failed' })).toBe('start');
    expect(decideMainlineAbsentRestart({ status: 'infra_error' })).toBe('start');
    expect(decideMainlineAbsentRestart({ status: 'pushed' })).toBe('start');
    expect(decideMainlineAbsentRestart(undefined)).toBe('start');
  });

  it('pushes a parked run, waits on an in-flight one, and respects a cancel', () => {
    expect(decideMainlineAbsentRestart({ status: 'ready_to_push' })).toBe('push_parked');
    expect(decideMainlineAbsentRestart({ status: 'reviewing' as never })).toBe('in_flight');
    expect(decideMainlineAbsentRestart({ status: 'cancelled' })).toBe('cancelled');
  });
});

describe('restartResultFromAutoPush', () => {
  it('accepts only a push that went through', () => {
    expect(restartResultFromAutoPush('r', { kind: 'pushed' }).kind).toBe('accepted');
    expect(
      restartResultFromAutoPush('r', { kind: 'push_failed', error: 'x', stillParked: true }).kind,
    ).toBe('retry');
    expect(
      restartResultFromAutoPush('r', { kind: 'push_failed', error: 'x', stillParked: false }).kind,
    ).toBe('dropped');
    expect(restartResultFromAutoPush('r', { kind: 'deferred', reason: 'lock' }).kind).toBe('retry');
    expect(restartResultFromAutoPush('r', { kind: 'blocked', reason: 'manual' }).kind).toBe(
      'dropped',
    );
  });
});

describe('restartFinalizeAfterMainlineAbsent with a parked run', () => {
  it('awaits the push: a failed push that re-parks the run is retry, not accepted', async () => {
    runs.set('r1', run('r1', 'ready_to_push'));
    latestId = 'r1';
    runFinalizePush.mockResolvedValueOnce({ ok: false, error: 'autopilot_slot_busy' });
    expect((await restartFinalizeAfterMainlineAbsent(SESSION)).kind).toBe('retry');

    runFinalizePush.mockRejectedValueOnce(new Error('spawn failed'));
    expect((await restartFinalizeAfterMainlineAbsent(SESSION)).kind).toBe('retry');

    acquirePushLock.mockResolvedValueOnce({ ok: false, heldBy: 'other' });
    expect((await restartFinalizeAfterMainlineAbsent(SESSION)).kind).toBe('retry');

    runFinalizePush.mockResolvedValueOnce({ ok: true, prUrl: null });
    expect((await restartFinalizeAfterMainlineAbsent(SESSION)).kind).toBe('accepted');
  });

  it('a kickoff that finds the head already parked pushes it and reports that push', async () => {
    runs.set('old', run('old', 'failed'));
    runs.set('r2', run('r2', 'ready_to_push'));
    latestId = 'old';
    startFinalizeRunBackground.mockResolvedValue({
      ok: false,
      error: 'ready_to_push',
      runId: 'r2',
    });
    runFinalizePush.mockResolvedValueOnce({ ok: false, error: 'autopilot_slot_busy' });
    expect((await restartFinalizeAfterMainlineAbsent(SESSION)).kind).toBe('retry');

    runFinalizePush.mockResolvedValueOnce({ ok: true, prUrl: null });
    expect((await restartFinalizeAfterMainlineAbsent(SESSION)).kind).toBe('accepted');
  });

  it('a push that ran and finished failed is dropped, with its reason', async () => {
    runs.set('r1', run('r1', 'ready_to_push'));
    latestId = 'r1';
    runFinalizePush.mockImplementationOnce(async () => {
      runs.set('r1', run('r1', 'failed'));
      return { ok: false, error: 'mainline_origin_refused' };
    });
    const out = await restartFinalizeAfterMainlineAbsent(SESSION);
    expect(out).toEqual({
      kind: 'dropped',
      detail: expect.stringContaining('mainline_origin_refused'),
    });
  });
});

describe('owed restart through the reconciler sweep', () => {
  function seed(): string {
    const id = `ml-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cfg: AutopilotSessionConfig = {
      durationHours: 0,
      brief: 'b',
      goal: 'g',
      escalation: 'medium',
      branch: 'main',
      startedAt: new Date().toISOString(),
      deadlineAt: null,
      status: 'running',
      cycle: 0,
      lastPushSha: null,
      target: 'mainline',
      mainline: {
        deployEnvironment: 'prod',
        landedCount: 0,
        slot: idleMainlineSlot(),
        restartOwed: { attemptId: 'att-1', sha: SHA, since: new Date().toISOString() },
      },
    };
    const stmts = getStmts();
    stmts.createSession.run(id, 'agent-ml-restart', 'Autopilot', 'claude-code', 'test', 1, 0, 1);
    stmts.updateSessionAutopilotConfig.run(JSON.stringify(cfg), id);
    return id;
  }

  function owed(id: string) {
    const row = getStmts().getSession.get(id) as { autopilot_session_config: string | null };
    return parseAutopilotSessionConfig(row.autopilot_session_config)!.mainline!.restartOwed ?? null;
  }

  it('a failed parked-push kickoff keeps the debt; a later sweep pushes and clears it', async () => {
    getDb().prepare(`DELETE FROM sessions WHERE agent_id = 'agent-ml-restart'`).run();
    const id = seed();
    runs.set('r1', run('r1', 'ready_to_push'));
    latestId = 'r1';
    let now = Date.parse('2026-09-27T12:00:00.000Z');
    const reconciler = createMainlineReconciler({
      stmts: getStmts(),
      isPushLive: () => false,
      checkRemote: async () => ({ kind: 'unknown', detail: 'unused' }),
      restartFinalize: () => restartFinalizeAfterMainlineAbsent(id),
      postNotice: () => {},
      now: () => now,
      log: () => {},
    });

    runFinalizePush.mockResolvedValueOnce({ ok: false, error: 'autopilot_slot_busy' });
    await reconciler.reconcile({ id, agent_id: 'agent-ml-restart' });
    await reconciler.settled();
    expect(runFinalizePush).toHaveBeenCalledTimes(1);
    expect(owed(id)?.attemptId).toBe('att-1');

    now += mainlineReconcileBackoffMs(1);
    runFinalizePush.mockResolvedValueOnce({ ok: true, prUrl: null });
    await reconciler.reconcile({ id, agent_id: 'agent-ml-restart' });
    await reconciler.settled();
    expect(runFinalizePush).toHaveBeenCalledTimes(2);
    expect(owed(id)).toBeNull();
  });
});
