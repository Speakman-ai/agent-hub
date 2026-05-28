/**
 * Tests for the live-mode "human walked away" stall watchdog. We drive
 * its timers with a fake scheduler so the tests are deterministic and
 * fast — no real wall-clock waits.
 *
 * Coverage targets:
 *
 *   - Autonomous trigger (`agent_block`) arms neither timer; the
 *     returned handle reports `armed: false` and `cancel()` is a no-op.
 *   - Live trigger (`ui_button`) arms both timers; the notify timer
 *     fires the push exactly once and the stall timer transitions the
 *     run to `stalled_no_response` exactly once.
 *   - `cancel()` clears both pending timers — neither push nor terminal
 *     write happens after cancel.
 *   - Window clamping: notify floored to MIN_NOTIFY_AFTER_MS; stall
 *     forced strictly greater than notify; non-finite inputs fall back
 *     to defaults.
 *   - Stall write path: `failFinalizeRun` is called with the
 *     `stalled_no_response` status/reason pair; a system message is
 *     inserted into the originating session via `addMessage` with the
 *     expected `kind` metadata; phase event is broadcast as terminal.
 *   - Push dispatch failure does not crash the watchdog — logged and
 *     continues.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_NOTIFY_AFTER_MS,
  DEFAULT_STALL_AFTER_MS,
  MAX_STALL_AFTER_MS,
  MIN_NOTIFY_AFTER_MS,
  armStallWatchdog,
  __test,
  type ScheduleTimer,
  type StallWatchdogDeps,
  type StallWatchdogOptions,
} from './stall-watchdog.js';

// ─── fake scheduler ───────────────────────────────────────────────────

interface Pending {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function makeFakeScheduler(): { schedule: ScheduleTimer; pending: Pending[] } {
  const pending: Pending[] = [];
  const schedule: ScheduleTimer = (fn, ms) => {
    const entry: Pending = { fn, ms, cleared: false };
    pending.push(entry);
    return {
      clear() {
        entry.cleared = true;
      },
    };
  };
  return { schedule, pending };
}

// ─── fake stmts ───────────────────────────────────────────────────────

interface FakeStmts {
  failFinalizeRun: { run: ReturnType<typeof vi.fn> };
  addMessage: { run: ReturnType<typeof vi.fn> };
  touchSession: { run: ReturnType<typeof vi.fn> };
  getMessageById: { get: ReturnType<typeof vi.fn> };
  updateFinalizeRunPhase: { run: ReturnType<typeof vi.fn> };
}

function makeStmts(): FakeStmts {
  return {
    failFinalizeRun: { run: vi.fn() },
    addMessage: { run: vi.fn() },
    touchSession: { run: vi.fn() },
    getMessageById: {
      get: vi.fn().mockImplementation((id: string) => ({
        id,
        session_id: 'sess-1',
        role: 'system',
        content: 'parked',
      })),
    },
    updateFinalizeRunPhase: { run: vi.fn() },
  };
}

function makeDeps(stmts: FakeStmts, opts?: { dispatchPush?: ReturnType<typeof vi.fn> }) {
  const broadcast = vi.fn();
  const dispatchPush = opts?.dispatchPush ?? vi.fn().mockResolvedValue(0);
  const { schedule, pending } = makeFakeScheduler();
  const log = vi.fn();
  let counter = 0;
  const deps: StallWatchdogDeps = {
    stmts: stmts as unknown as StallWatchdogDeps['stmts'],
    broadcast,
    dispatchPush: dispatchPush as never,
    scheduleTimer: schedule,
    now: () => 1_700_000_000_000,
    newId: () => `msg-${++counter}`,
    log,
  };
  return { deps, broadcast, dispatchPush, pending, log };
}

const baseOpts = (overrides: Partial<StallWatchdogOptions> = {}): StallWatchdogOptions => ({
  runId: 'run-1',
  sessionId: 'sess-1',
  projectId: 'proj-1',
  cardId: 'card-1',
  triggerSource: 'ui_button',
  cardTitle: 'Wire reviewer dispatch',
  ...overrides,
});

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── tests ────────────────────────────────────────────────────────────

describe('armStallWatchdog — autonomous mode is a no-op', () => {
  it('does not arm timers when triggerSource is agent_block', () => {
    const stmts = makeStmts();
    const { deps, pending } = makeDeps(stmts);
    const onStall = vi.fn();
    const handle = armStallWatchdog(deps, baseOpts({ triggerSource: 'agent_block' }), onStall);
    expect(pending).toHaveLength(0);
    expect(handle.state().armed).toBe(false);
    handle.cancel();
    expect(handle.state().armed).toBe(false);
    expect(onStall).not.toHaveBeenCalled();
  });
});

describe('armStallWatchdog — live mode arms both timers', () => {
  it('schedules notify then stall', () => {
    const stmts = makeStmts();
    const { deps, pending } = makeDeps(stmts);
    armStallWatchdog(deps, baseOpts(), vi.fn());

    expect(pending).toHaveLength(2);
    expect(pending[0].ms).toBe(DEFAULT_NOTIFY_AFTER_MS);
    expect(pending[1].ms).toBe(DEFAULT_STALL_AFTER_MS);
  });

  it('notify timer fires push exactly once, leaves run waiting', async () => {
    const stmts = makeStmts();
    const dispatchPush = vi.fn().mockResolvedValue(1);
    const { deps, pending } = makeDeps(stmts, { dispatchPush });
    const onStall = vi.fn();
    const handle = armStallWatchdog(deps, baseOpts(), onStall);

    // Trip the notify timer.
    pending[0].fn();
    // Push is async-fire-and-forget; await a microtask to let it settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(dispatchPush).toHaveBeenCalledTimes(1);
    expect(dispatchPush.mock.calls[0][0]).toBe('finalize_stall_warning');
    const payload = dispatchPush.mock.calls[0][1] as {
      data: Record<string, unknown>;
      body: string;
    };
    expect(payload.data.runId).toBe('run-1');
    expect(payload.data.sessionId).toBe('sess-1');
    expect(payload.data.cardId).toBe('card-1');
    expect(payload.data.type).toBe('finalize_stall_warning');
    expect(payload.body).toContain('Wire reviewer dispatch');

    // Idempotency: the notify lambda is fired exactly once even if the
    // fake timer is re-triggered.
    pending[0].fn();
    await Promise.resolve();
    expect(dispatchPush).toHaveBeenCalledTimes(1);

    // Stall timer has NOT fired yet — run continues waiting.
    expect(stmts.failFinalizeRun.run).not.toHaveBeenCalled();
    expect(onStall).not.toHaveBeenCalled();
    expect(handle.state()).toMatchObject({
      armed: true,
      notified: true,
      stalled: false,
      cancelled: false,
    });
  });

  it('stall timer parks the run as stalled_no_response and writes a session message', () => {
    const stmts = makeStmts();
    const { deps, broadcast, pending } = makeDeps(stmts);
    const onStall = vi.fn();
    armStallWatchdog(deps, baseOpts(), onStall);

    // Skip the notify timer for this assertion — fire only the stall.
    pending[1].fn();

    expect(stmts.failFinalizeRun.run).toHaveBeenCalledTimes(1);
    expect(stmts.failFinalizeRun.run).toHaveBeenCalledWith(
      'stalled_no_response',
      'stalled_no_response',
      'run-1',
    );

    // Phase event flips to terminal with the stalled status.
    const phaseEvent = broadcast.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((e) => e.type === 'finalize_run_phase_changed');
    expect(phaseEvent).toMatchObject({
      run_id: 'run-1',
      phase: 'dispatching',
      status: 'stalled_no_response',
      failure_reason: 'stalled_no_response',
    });

    // Session message written; the agent picking the conversation back
    // up should see what happened.
    expect(stmts.addMessage.run).toHaveBeenCalledTimes(1);
    const addCall = stmts.addMessage.run.mock.calls[0];
    expect(addCall[1]).toBe('sess-1'); // sessionId
    expect(addCall[2]).toBe('system'); // role
    expect(addCall[3]).toMatch(/parked after/i);
    expect(addCall[3]).toContain('retrigger');
    const meta = JSON.parse(addCall[7] as string) as Record<string, unknown>;
    expect(meta.kind).toBe('finalize_stalled_no_response');
    expect(meta.runId).toBe('run-1');

    // Caller is notified.
    expect(onStall).toHaveBeenCalledWith('stalled_no_response');
  });
});

describe('armStallWatchdog — cancel clears both timers', () => {
  it('does not push or terminate after cancel', async () => {
    const stmts = makeStmts();
    const dispatchPush = vi.fn().mockResolvedValue(1);
    const { deps, pending } = makeDeps(stmts, { dispatchPush });
    const onStall = vi.fn();
    const handle = armStallWatchdog(deps, baseOpts(), onStall);

    handle.cancel();
    expect(pending[0].cleared).toBe(true);
    expect(pending[1].cleared).toBe(true);

    // Even if the fake fires the timer fn directly (simulating a race
    // where the timer fired just before clear), the cancelled flag
    // suppresses the work.
    pending[0].fn();
    pending[1].fn();
    await Promise.resolve();

    expect(dispatchPush).not.toHaveBeenCalled();
    expect(stmts.failFinalizeRun.run).not.toHaveBeenCalled();
    expect(onStall).not.toHaveBeenCalled();
    expect(handle.state().cancelled).toBe(true);
  });

  it('cancel is idempotent', () => {
    const stmts = makeStmts();
    const { deps } = makeDeps(stmts);
    const handle = armStallWatchdog(deps, baseOpts(), vi.fn());
    expect(() => {
      handle.cancel();
      handle.cancel();
      handle.cancel();
    }).not.toThrow();
  });
});

describe('armStallWatchdog — push dispatch failure is non-fatal', () => {
  it('logs and continues when dispatchPush rejects', async () => {
    const stmts = makeStmts();
    const dispatchPush = vi.fn().mockRejectedValue(new Error('expo down'));
    const { deps, pending, log } = makeDeps(stmts, { dispatchPush });
    armStallWatchdog(deps, baseOpts(), vi.fn());

    pending[0].fn();
    await Promise.resolve();
    await Promise.resolve();

    expect(log).toHaveBeenCalled();
    const logged = log.mock.calls.map((c) => c[0] as string).join('\n');
    expect(logged).toMatch(/push dispatch failed/i);
    // Stall timer still armed.
    expect(stmts.failFinalizeRun.run).not.toHaveBeenCalled();
  });
});

describe('resolveWindows — clamping rules', () => {
  it('floors notify to MIN_NOTIFY_AFTER_MS', () => {
    const log = vi.fn();
    const { notifyAfterMs } = __test.resolveWindows({
      notifyAfterMs: 100, // below floor
      stallAfterMs: DEFAULT_STALL_AFTER_MS,
      log,
    });
    expect(notifyAfterMs).toBe(MIN_NOTIFY_AFTER_MS);
    expect(log).toHaveBeenCalled();
  });

  it('forces stall to be strictly greater than notify', () => {
    const log = vi.fn();
    const { notifyAfterMs, stallAfterMs } = __test.resolveWindows({
      notifyAfterMs: 5 * 60_000,
      stallAfterMs: 5 * 60_000, // equal — must be bumped to notify+1
      log,
    });
    expect(notifyAfterMs).toBe(5 * 60_000);
    expect(stallAfterMs).toBeGreaterThan(notifyAfterMs);
  });

  it('caps both at MAX_STALL_AFTER_MS', () => {
    const log = vi.fn();
    const { notifyAfterMs, stallAfterMs } = __test.resolveWindows({
      notifyAfterMs: MAX_STALL_AFTER_MS * 10,
      stallAfterMs: MAX_STALL_AFTER_MS * 10,
      log,
    });
    expect(notifyAfterMs).toBe(MAX_STALL_AFTER_MS);
    expect(stallAfterMs).toBe(MAX_STALL_AFTER_MS);
  });

  it('falls back to defaults on non-finite inputs', () => {
    const log = vi.fn();
    const { notifyAfterMs, stallAfterMs } = __test.resolveWindows({
      notifyAfterMs: Number.NaN,
      stallAfterMs: -1,
      log,
    });
    expect(notifyAfterMs).toBe(DEFAULT_NOTIFY_AFTER_MS);
    expect(stallAfterMs).toBe(DEFAULT_STALL_AFTER_MS);
  });

  it('respects valid in-range overrides without clamping', () => {
    const log = vi.fn();
    const { notifyAfterMs, stallAfterMs } = __test.resolveWindows({
      notifyAfterMs: 10 * 60_000,
      stallAfterMs: 60 * 60_000,
      log,
    });
    expect(notifyAfterMs).toBe(10 * 60_000);
    expect(stallAfterMs).toBe(60 * 60_000);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('armStallWatchdog — accepts per-project window overrides', () => {
  it('uses the override windows on the underlying scheduler', () => {
    const stmts = makeStmts();
    const { deps, pending } = makeDeps(stmts);
    armStallWatchdog(
      deps,
      baseOpts({
        notifyAfterMs: 10 * 60_000,
        stallAfterMs: 60 * 60_000,
      }),
      vi.fn(),
    );
    expect(pending).toHaveLength(2);
    expect(pending[0].ms).toBe(10 * 60_000);
    expect(pending[1].ms).toBe(60 * 60_000);
  });
});
