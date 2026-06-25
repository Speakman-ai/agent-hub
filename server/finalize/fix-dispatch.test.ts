/**
 * Tests for the fix-dispatch helper. The helper owns three things:
 *
 *   1. The §7 message composer (pure — exhaustively covered here).
 *   2. The DB side effects (phase flip, active-seconds bump, addMessage
 *      insert + broadcast).
 *   3. The await-turn-end + stall-watchdog race (deterministic via
 *      injected schedulers + turn-end subscribers).
 *
 * No real CLI binaries, no real timers, no real db. We stub everything
 * the helper touches so the run is sub-millisecond.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewerThreadRow } from '../types.js';
import {
  DISPATCH_PHASE_ENTRY_ACTIVE_SECONDS,
  DISPATCH_TRAILER,
  DISPATCH_TRAILER_REVIEWER,
  composeDispatchBody,
  dispatchFixMessage,
  type CancelSignal,
  type FixDispatchDeps,
  type FixDispatchOptions,
  type FixDispatchTrigger,
  type TurnEndSubscriber,
} from './fix-dispatch.js';
import { RUNNER_TEARDOWN_DISPATCH_HINT } from './runner-teardown.js';

// ─── §7 composer tests ────────────────────────────────────────────────

describe('composeDispatchBody', () => {
  const trailerLines = ['', DISPATCH_TRAILER];

  it('renders the step-failed header verbatim', () => {
    const body = composeDispatchBody({
      failedStep: {
        phase: 'tasks',
        name: 'Typecheck',
        exitCode: 2,
        outputTail: ['error TS2304: Cannot find name foo'],
      },
    });
    expect(body.split('\n')[0]).toBe(
      'Finalize Code Changes: phase=tasks, step "Typecheck" failed (exit 2).',
    );
  });

  it('renders the reviewer-only header when there is no failed step', () => {
    const threads: ReviewerThreadRow[] = [
      {
        id: 't1',
        run_id: 'r1',
        file_path: 'server/foo.ts',
        line_start: 42,
        line_end: 42,
        body: '**[6/10]** Off by one in the boundary check.',
        author: 'reviewer-agent',
        created_at: 1,
      },
    ];
    const body = composeDispatchBody({
      reviewerVerdict: 'changes_requested',
      reviewerThreads: threads,
    });
    expect(body.split('\n')[0]).toBe(
      'Finalize Code Changes: phase=review, reviewer requested changes.',
    );
    expect(body).toContain('Reviewer notes:');
    expect(body).toContain('server/foo.ts:42 — **[6/10]** Off by one');
    expect(body.endsWith(`\n${DISPATCH_TRAILER_REVIEWER}`)).toBe(true);
  });

  it('combines step failure + reviewer threads into one body', () => {
    const threads: ReviewerThreadRow[] = [
      {
        id: 't1',
        run_id: 'r1',
        file_path: 'server/foo.ts',
        line_start: 10,
        line_end: 12,
        body: '**[4/10]** Refactor opportunity.',
        author: 'reviewer-agent',
        created_at: 1,
      },
    ];
    const body = composeDispatchBody({
      failedStep: {
        phase: 'tasks',
        name: 'Test',
        exitCode: 1,
        outputTail: ['1 failing test', 'FAIL server/foo.test.ts'],
      },
      reviewerVerdict: 'changes_requested',
      reviewerThreads: threads,
    });
    const lines = body.split('\n');
    expect(lines[0]).toContain('phase=tasks, step "Test" failed (exit 1)');
    expect(body).toContain('Last output (40 lines):');
    expect(body).toContain('1 failing test');
    expect(body).toContain('Reviewer notes:');
    expect(body).toContain('server/foo.ts:10-12 — **[4/10]** Refactor');
    expect(lines.slice(-trailerLines.length)).toEqual(trailerLines);
  });

  it('leads with the failure excerpt, above the raw trailing tail', () => {
    const body = composeDispatchBody({
      failedStep: {
        phase: 'tasks',
        name: 'E2E',
        exitCode: 1,
        failureExcerpt: ['1 failing', 'CypressError: this element is not visible'],
        outputTail: [
          'db-1  | LOG:  checkpoint complete: wrote 3 buffers',
          'db-1  | LOG:  checkpoint complete: wrote 4 buffers',
        ],
      },
    });
    expect(body).toContain('Likely failure (excerpt):');
    expect(body).toContain('CypressError: this element is not visible');
    expect(body).toContain('Last output (40 lines):');
    // Excerpt section appears before the raw tail section.
    expect(body.indexOf('Likely failure (excerpt):')).toBeLessThan(
      body.indexOf('Last output (40 lines):'),
    );
  });

  it('omits the excerpt section when no failure marker was detected', () => {
    const body = composeDispatchBody({
      failedStep: {
        phase: 'tasks',
        name: 'E2E',
        exitCode: 1,
        outputTail: ['some output'],
      },
    });
    expect(body).not.toContain('Likely failure (excerpt):');
    expect(body).toContain('Last output (40 lines):');
  });

  it('handles an empty output tail', () => {
    const body = composeDispatchBody({
      failedStep: {
        phase: 'tasks',
        name: 'Install',
        exitCode: 127,
        outputTail: [],
      },
    });
    expect(body).toContain('Last output (40 lines):');
    expect(body).toContain('(no output captured)');
  });

  it('falls back to a placeholder when changes_requested has no anchored threads', () => {
    const body = composeDispatchBody({
      reviewerVerdict: 'changes_requested',
      reviewerThreads: [],
    });
    expect(body).toContain('Reviewer notes:');
    expect(body).toContain(
      '(no anchored notes — verdict was changes_requested without per-file findings)',
    );
  });

  it('returns empty string when nothing useful is present', () => {
    expect(composeDispatchBody({})).toBe('');
    expect(composeDispatchBody({ reviewerVerdict: 'approved', reviewerThreads: [] })).toBe('');
  });

  // The checks scheduler waits for ALL parallel jobs to finish before the
  // orchestrator dispatches, so a single fix turn must surface every red.
  it('enumerates every failure when multiple parallel jobs went red', () => {
    const body = composeDispatchBody({
      failedStep: {
        phase: 'tasks',
        name: 'test',
        exitCode: 1,
        outputTail: ['FAIL server/foo.test.ts'],
        jobId: 'backend',
        matrixKey: 'node-20',
      },
      failedSteps: [
        {
          phase: 'tasks',
          name: 'test',
          exitCode: 1,
          outputTail: ['FAIL server/foo.test.ts'],
          jobId: 'backend',
          matrixKey: 'node-20',
        },
        {
          phase: 'tasks',
          name: 'build',
          exitCode: 2,
          outputTail: ['error TS2304: Cannot find name bar'],
          jobId: 'frontend',
        },
      ],
    });
    const lines = body.split('\n');
    expect(lines[0]).toBe('Finalize Code Changes: phase=tasks, 2 steps failed across CI jobs.');
    expect(body).toContain(
      'Failure 1 of 2 — job "backend" / shard "node-20", step "test" failed (exit 1).',
    );
    expect(body).toContain('Failure 2 of 2 — job "frontend", step "build" failed (exit 2).');
    // Both jobs' evidence is present.
    expect(body).toContain('FAIL server/foo.test.ts');
    expect(body).toContain('error TS2304: Cannot find name bar');
    // Locked trailer still closes the body.
    expect(body.endsWith(`\n${DISPATCH_TRAILER}`)).toBe(true);
  });

  // A single-element failedSteps must NOT switch to the multi-failure header —
  // the legacy single-failure shape stays byte-for-byte identical.
  it('keeps the single-failure header when only one job failed', () => {
    const single = {
      phase: 'tasks' as const,
      name: 'Typecheck',
      exitCode: 2,
      outputTail: ['error TS2304: Cannot find name foo'],
    };
    const withArray = composeDispatchBody({ failedStep: single, failedSteps: [single] });
    const withoutArray = composeDispatchBody({ failedStep: single });
    expect(withArray).toBe(withoutArray);
    expect(withArray.split('\n')[0]).toBe(
      'Finalize Code Changes: phase=tasks, step "Typecheck" failed (exit 2).',
    );
    expect(withArray).not.toContain('steps failed across CI jobs');
  });

  it('ends with the locked trailer', () => {
    const body = composeDispatchBody({
      failedStep: {
        phase: 'tasks',
        name: 'Test',
        exitCode: 1,
        outputTail: ['boom'],
      },
    });
    expect(body.endsWith(`\n${DISPATCH_TRAILER}`)).toBe(true);
  });

  // Layer B: a fix round that slips past the step-runner's infra reclassifier
  // and reaches dispatch should still tell the agent a context-canceled
  // teardown is not a real failure, so it doesn't waste the round chasing it.
  it('prepends the runner-teardown hint when the failed step is a context-canceled teardown', () => {
    const body = composeDispatchBody({
      failedStep: {
        phase: 'tasks',
        name: 'Tests (client)',
        exitCode: 1,
        outputTail: ['✓ src/components/Foo.test.tsx (4 tests)', 'context canceled'],
      },
    });
    expect(body).toContain(RUNNER_TEARDOWN_DISPATCH_HINT);
    // Header + trailer are still present — the hint is additive.
    expect(body.split('\n')[0]).toContain('step "Tests (client)" failed (exit 1)');
    expect(body.endsWith(`\n${DISPATCH_TRAILER}`)).toBe(true);
  });

  // The case the reviewer flagged: a teardown whose sentinel is NOT in the
  // strict terminal window is exactly what Layer A misses (so it lands here as
  // a `failure`). The dispatch-side check is intentionally BROADER than Layer
  // A's, so the hint still fires — proving Layer B is not dead code.
  it('prepends the hint for a teardown whose sentinel is outside the terminal window', () => {
    const body = composeDispatchBody({
      failedStep: {
        phase: 'tasks',
        name: 'Tests (client)',
        exitCode: 1,
        outputTail: [
          '✓ src/components/Foo.test.tsx (4 tests)',
          'context canceled',
          'runner: stopping inner dockerd',
          'runner: removing graph volume',
          'runner: lease released',
        ],
      },
    });
    expect(body).toContain(RUNNER_TEARDOWN_DISPATCH_HINT);
  });

  it('does NOT prepend the teardown hint for a genuine failure', () => {
    const body = composeDispatchBody({
      failedStep: {
        phase: 'tasks',
        name: 'Tests (client)',
        exitCode: 1,
        outputTail: ['Tests  3 failed | 900 passed (903)', 'context canceled'],
      },
    });
    // A real red that also logged context-canceled keeps its failure summary,
    // so the hint must NOT appear.
    expect(body).not.toContain(RUNNER_TEARDOWN_DISPATCH_HINT);
  });

  // Regression: a spawned agent has no web "session strip". The trailer
  // must point it at the retrieval surface it CAN reach (the finalize.sh
  // wrapper / REST endpoints), not the UI. Earlier wording told the agent
  // to "read step logs in the session strip", which wasted a whole fix
  // turn while it hunted for a way to see the failure output.
  it('points the agent at the log-retrieval surface, not the web strip', () => {
    expect(DISPATCH_TRAILER).not.toContain('session strip');
    // The wrapper subcommands the agent should reach for.
    expect(DISPATCH_TRAILER).toContain('finalize.sh failed');
    expect(DISPATCH_TRAILER).toContain('finalize.sh latest');
    expect(DISPATCH_TRAILER).toContain('finalize.sh output');
    // The underlying REST endpoints, in case the wrapper is unavailable.
    expect(DISPATCH_TRAILER).toContain('/finalize-runs/latest');
    expect(DISPATCH_TRAILER).toContain('/steps/:stepIndex/output');
  });
});

// ─── dispatch flow tests ──────────────────────────────────────────────

interface FakeStmts {
  updateFinalizeRunPhase: { run: ReturnType<typeof vi.fn> };
  updateFinalizeRunActiveSeconds: { run: ReturnType<typeof vi.fn> };
  addMessage: { run: ReturnType<typeof vi.fn> };
  getMessageById: { get: ReturnType<typeof vi.fn> };
  touchSession: { run: ReturnType<typeof vi.fn> };
  failFinalizeRun: { run: ReturnType<typeof vi.fn> };
}

function makeStmts(): FakeStmts {
  const inserted = new Map<string, Record<string, unknown>>();
  const addMessage = vi.fn((id: string, sessionId: string, role: string, content: string) => {
    inserted.set(id, { id, session_id: sessionId, role, content });
  });
  return {
    updateFinalizeRunPhase: { run: vi.fn() },
    updateFinalizeRunActiveSeconds: { run: vi.fn() },
    addMessage: { run: addMessage },
    getMessageById: {
      get: vi.fn(
        (id: string) =>
          inserted.get(id) ?? { id, session_id: 'sess-1', role: 'system', content: '' },
      ),
    },
    touchSession: { run: vi.fn() },
    failFinalizeRun: { run: vi.fn() },
  };
}

interface TurnEndHandle {
  subscriber: TurnEndSubscriber;
  fireFor(sessionId: string): void;
  subscribers(sessionId: string): number;
}

function makeTurnEnd(): TurnEndHandle {
  const map = new Map<string, Set<(outcome: 'turn_ended' | 'spawn_failed') => void>>();
  return {
    subscriber: {
      subscribe(sessionId, listener) {
        const set = map.get(sessionId) ?? new Set();
        set.add(listener);
        map.set(sessionId, set);
        return () => {
          set.delete(listener);
          if (set.size === 0) map.delete(sessionId);
        };
      },
    },
    fireFor(sessionId, outcome: 'turn_ended' | 'spawn_failed' = 'turn_ended') {
      const set = map.get(sessionId);
      if (!set) return;
      for (const fn of [...set]) fn(outcome);
    },
    subscribers(sessionId) {
      return map.get(sessionId)?.size ?? 0;
    },
  };
}

interface FakeTimerHandle {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function makeTimerBus(): {
  schedule: NonNullable<NonNullable<FixDispatchDeps['stallWatchdog']>['scheduleTimer']>;
  pending: FakeTimerHandle[];
} {
  const pending: FakeTimerHandle[] = [];
  return {
    schedule(fn, ms) {
      const entry: FakeTimerHandle = { fn, ms, cleared: false };
      pending.push(entry);
      return {
        clear() {
          entry.cleared = true;
        },
      };
    },
    pending,
  };
}

function makeCancelSignal(): { signal: CancelSignal; abort: () => void } {
  let aborted = false;
  const listeners = new Set<() => void>();
  return {
    signal: {
      get aborted() {
        return aborted;
      },
      onAbort(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    abort() {
      if (aborted) return;
      aborted = true;
      for (const fn of [...listeners]) fn();
    },
  };
}

const baseOpts = (overrides: Partial<FixDispatchOptions> = {}): FixDispatchOptions => ({
  runId: 'run-1',
  sessionId: 'sess-1',
  projectId: 'proj-1',
  cardId: 'card-1',
  triggerSource: 'ui_button',
  cardTitle: 'Wire reviewer dispatch',
  trigger: {
    failedStep: {
      phase: 'tasks',
      name: 'Test',
      exitCode: 1,
      outputTail: ['1 failing test'],
    },
  },
  ...overrides,
});

function makeDeps(args?: {
  schedule?: ReturnType<typeof makeTimerBus>['schedule'];
  spawnFixTurn?: FixDispatchDeps['spawnFixTurn'];
}): {
  deps: FixDispatchDeps;
  stmts: FakeStmts;
  broadcast: ReturnType<typeof vi.fn>;
  turnEnd: TurnEndHandle;
} {
  const stmts = makeStmts();
  const broadcast = vi.fn();
  const turnEnd = makeTurnEnd();
  let counter = 0;
  const deps: FixDispatchDeps = {
    stmts: stmts as unknown as FixDispatchDeps['stmts'],
    broadcast,
    turnEnd: turnEnd.subscriber,
    stallWatchdog: {
      scheduleTimer: args?.schedule,
      now: () => 1_700_000_000_000,
      newId: () => `stall-msg-${++counter}`,
    },
    now: () => 1_700_000_000_000,
    newId: () => `fix-msg-${++counter}`,
    log: vi.fn(),
    spawnFixTurn: args?.spawnFixTurn,
  };
  return { deps, stmts, broadcast, turnEnd };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dispatchFixMessage — turn-end resolves the dispatch', () => {
  it('inserts the §7 message, billing the entry charge, and resolves with turn_ended', async () => {
    const { deps, stmts, broadcast, turnEnd } = makeDeps();
    const promise = dispatchFixMessage(deps, baseOpts());

    // The composer + insert happens synchronously before the await
    // takes hold; assert the side effects landed.
    // The originating phase is PRESERVED (a checks-failure fix keeps
    // `phase='tasks'`); only `status` flips to `'dispatching'`. This is what
    // lets a cold fetch / reconnect mid-fix re-derive `awaitingChecksFix` and
    // keep the live checks block on screen during a failed round.
    expect(stmts.updateFinalizeRunPhase.run).toHaveBeenCalledWith('tasks', 'dispatching', 'run-1');
    expect(stmts.updateFinalizeRunActiveSeconds.run).toHaveBeenCalledWith(
      DISPATCH_PHASE_ENTRY_ACTIVE_SECONDS,
      'run-1',
    );
    expect(stmts.addMessage.run).toHaveBeenCalledTimes(1);
    const addArgs = stmts.addMessage.run.mock.calls[0];
    expect(addArgs[2]).toBe('system');
    expect(addArgs[3]).toContain('phase=tasks, step "Test" failed (exit 1)');
    expect(addArgs[3]).toContain('1 failing test');
    expect(addArgs[3]).toContain(DISPATCH_TRAILER);
    const meta = JSON.parse(addArgs[7] as string) as Record<string, unknown>;
    expect(meta.kind).toBe('finalize_fix_dispatch');
    expect(meta.failedStepName).toBe('Test');

    // Message broadcast happens too.
    const types = broadcast.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain('finalize_run_phase_changed');
    expect(types).toContain('message');

    // Turn-end subscriber registered for the right session.
    expect(turnEnd.subscribers('sess-1')).toBe(1);

    // Fire turn-end and assert resolution.
    turnEnd.fireFor('sess-1');
    const result = await promise;
    expect(result.outcome).toBe('turn_ended');
    expect(result.messageId).toMatch(/^fix-msg-/);
    expect(result.activeSecondsBilled).toBe(DISPATCH_PHASE_ENTRY_ACTIVE_SECONDS);

    // Cleanup: subscriber is removed.
    expect(turnEnd.subscribers('sess-1')).toBe(0);
  });

  it('preserves the originating phase on the row + broadcast (checks fix → tasks, reviewer fix → review)', async () => {
    // Regression: dispatchFixMessage used to clobber `phase` to 'dispatching',
    // which made `awaitingChecksFix` (status==='dispatching' && phase==='tasks')
    // underivable from a cold fetch / reconnect — the live checks block then
    // silently vanished for the whole fix loop on every FAILED round, showing
    // only after the round completed and only on failure.

    // Checks-failure fix: `phase` must stay 'tasks'.
    {
      const { deps, stmts, broadcast, turnEnd } = makeDeps();
      const promise = dispatchFixMessage(
        deps,
        baseOpts({
          trigger: {
            failedStep: { phase: 'tasks', name: 'Test', exitCode: 1, outputTail: ['boom'] },
          },
        }),
      );
      expect(stmts.updateFinalizeRunPhase.run).toHaveBeenCalledWith(
        'tasks',
        'dispatching',
        'run-1',
      );
      const phaseEvent = broadcast.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((e) => e.type === 'finalize_run_phase_changed');
      expect(phaseEvent).toMatchObject({ phase: 'tasks', status: 'dispatching' });
      turnEnd.fireFor('sess-1');
      await promise;
    }

    // Reviewer-only fix (no failed step): `phase` must be 'review', so the
    // live CHECKS block stays hidden (awaitingChecksFix === false) — the
    // reviewer panel owns that surface.
    {
      const { deps, stmts, broadcast, turnEnd } = makeDeps();
      const promise = dispatchFixMessage(
        deps,
        baseOpts({
          trigger: {
            failedStep: null,
            reviewerVerdict: 'changes_requested',
            reviewerThreads: [
              {
                id: 't1',
                run_id: 'run-1',
                file_path: 'server/a.ts',
                line_start: 1,
                line_end: 1,
                body: '**[6/10]** please fix',
                author: 'reviewer-agent',
                created_at: 1,
              },
            ] satisfies ReviewerThreadRow[],
          },
        }),
      );
      expect(stmts.updateFinalizeRunPhase.run).toHaveBeenCalledWith(
        'review',
        'dispatching',
        'run-1',
      );
      const phaseEvent = broadcast.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((e) => e.type === 'finalize_run_phase_changed');
      expect(phaseEvent).toMatchObject({ phase: 'review', status: 'dispatching' });
      turnEnd.fireFor('sess-1');
      await promise;
    }
  });

  it('invokes spawnFixTurn after inserting the system message', async () => {
    const spawnFixTurn = vi.fn().mockResolvedValue({ spawned: true });
    const { deps, turnEnd } = makeDeps({ spawnFixTurn });
    const promise = dispatchFixMessage(deps, baseOpts());
    await Promise.resolve();
    expect(spawnFixTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        body: expect.stringContaining('phase=tasks'),
      }),
    );
    expect(turnEnd.subscribers('sess-1')).toBe(1);
    turnEnd.fireFor('sess-1');
    await promise;
  });

  it('does not miss a turn-end emitted before spawnFixTurn resolves', async () => {
    const { deps, turnEnd } = makeDeps();
    const spawnFixTurn = vi.fn(async () => {
      turnEnd.fireFor('sess-1');
      return { spawned: true };
    });
    deps.spawnFixTurn = spawnFixTurn;

    const result = await dispatchFixMessage(deps, baseOpts());

    expect(result.outcome).toBe('turn_ended');
    expect(spawnFixTurn).toHaveBeenCalledTimes(1);
    expect(turnEnd.subscribers('sess-1')).toBe(0);
  });

  it('returns spawn_failed when spawnFixTurn does not start the agent', async () => {
    const spawnFixTurn = vi.fn().mockResolvedValue({ spawned: false });
    const { deps, turnEnd } = makeDeps({ spawnFixTurn });
    const result = await dispatchFixMessage(deps, baseOpts());
    expect(result.outcome).toBe('spawn_failed');
    expect(turnEnd.subscribers('sess-1')).toBe(0);
  });

  it('skips the active-seconds charge when asked', async () => {
    const { deps, stmts, turnEnd } = makeDeps();
    const promise = dispatchFixMessage(deps, baseOpts({ skipActiveSecondsCharge: true }));
    expect(stmts.updateFinalizeRunActiveSeconds.run).not.toHaveBeenCalled();
    turnEnd.fireFor('sess-1');
    const result = await promise;
    expect(result.activeSecondsBilled).toBe(0);
  });
});

describe('dispatchFixMessage — stall watchdog interaction', () => {
  it('does not arm the watchdog in autonomous mode', async () => {
    const bus = makeTimerBus();
    const { deps, turnEnd } = makeDeps({ schedule: bus.schedule });
    const promise = dispatchFixMessage(deps, baseOpts({ triggerSource: 'agent_block' }));
    expect(bus.pending).toHaveLength(0);
    turnEnd.fireFor('sess-1');
    const result = await promise;
    expect(result.outcome).toBe('turn_ended');
  });

  it('arms the watchdog in live mode and cancels it on turn-end', async () => {
    const bus = makeTimerBus();
    const { deps, turnEnd } = makeDeps({ schedule: bus.schedule });
    const promise = dispatchFixMessage(deps, baseOpts());
    expect(bus.pending).toHaveLength(2); // notify + stall

    turnEnd.fireFor('sess-1');
    const result = await promise;
    expect(result.outcome).toBe('turn_ended');
    // Both timers should have been cleared on resolve.
    expect(bus.pending.every((p) => p.cleared)).toBe(true);
  });

  it('resolves with stalled_no_response when the stall timer fires before turn-end', async () => {
    const bus = makeTimerBus();
    const { deps, stmts, broadcast } = makeDeps({ schedule: bus.schedule });
    const promise = dispatchFixMessage(deps, baseOpts());

    // Fire stall timer directly (notify timer ignored).
    bus.pending[1].fn();

    const result = await promise;
    expect(result.outcome).toBe('stalled_no_response');

    // The watchdog wrote the terminal state.
    expect(stmts.failFinalizeRun.run).toHaveBeenCalledWith(
      'stalled_no_response',
      'stalled_no_response',
      'run-1',
    );
    // Phase event flipped to terminal.
    const phaseEvents = broadcast.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === 'finalize_run_phase_changed');
    expect(phaseEvents.some((e) => e.status === 'stalled_no_response')).toBe(true);
  });

  it('forwards per-project window overrides to the watchdog', async () => {
    const bus = makeTimerBus();
    const { deps, turnEnd } = makeDeps({ schedule: bus.schedule });
    const promise = dispatchFixMessage(
      deps,
      baseOpts({ notifyAfterMs: 10 * 60_000, stallAfterMs: 60 * 60_000 }),
    );
    expect(bus.pending[0].ms).toBe(10 * 60_000);
    expect(bus.pending[1].ms).toBe(60 * 60_000);
    turnEnd.fireFor('sess-1');
    await promise;
  });
});

describe('dispatchFixMessage — cancel signal', () => {
  it('returns cancelled if the signal is already aborted at entry', async () => {
    const { signal, abort } = makeCancelSignal();
    abort();
    const { deps, turnEnd } = makeDeps();
    const result = await dispatchFixMessage(deps, baseOpts({ signal }));
    expect(result.outcome).toBe('cancelled');
    // No turn-end listener should remain (we never subscribed).
    expect(turnEnd.subscribers('sess-1')).toBe(0);
  });

  it('returns cancelled when the signal aborts mid-wait', async () => {
    const { signal, abort } = makeCancelSignal();
    const { deps, turnEnd } = makeDeps();
    const promise = dispatchFixMessage(deps, baseOpts({ signal }));
    abort();
    const result = await promise;
    expect(result.outcome).toBe('cancelled');
    // Subscriber should be cleaned up.
    expect(turnEnd.subscribers('sess-1')).toBe(0);
  });
});

describe('dispatchFixMessage — empty trigger short-circuits', () => {
  it('refuses to dispatch when the trigger has no useful signal', async () => {
    const { deps, stmts } = makeDeps();
    const trigger: FixDispatchTrigger = {};
    const result = await dispatchFixMessage(deps, baseOpts({ trigger }));
    expect(result.outcome).toBe('cancelled');
    expect(stmts.addMessage.run).not.toHaveBeenCalled();
  });
});

describe('dispatchFixMessage — addMessage failure is fatal', () => {
  it('surfaces cancelled when message insert throws', async () => {
    const { deps, stmts } = makeDeps();
    stmts.addMessage.run.mockImplementationOnce(() => {
      throw new Error('db locked');
    });
    const result = await dispatchFixMessage(deps, baseOpts());
    expect(result.outcome).toBe('cancelled');
  });
});

describe('dispatchFixMessage — uniform shape across live and autonomous', () => {
  it('produces the same composed body regardless of trigger source', async () => {
    const trigger: FixDispatchTrigger = {
      failedStep: { phase: 'tasks', name: 'Lint', exitCode: 1, outputTail: ['warn'] },
    };

    const live = makeDeps();
    const auto = makeDeps();

    const livePromise = dispatchFixMessage(
      live.deps,
      baseOpts({ triggerSource: 'ui_button', trigger }),
    );
    const autoPromise = dispatchFixMessage(
      auto.deps,
      baseOpts({ triggerSource: 'agent_block', trigger }),
    );

    live.turnEnd.fireFor('sess-1');
    auto.turnEnd.fireFor('sess-1');
    await Promise.all([livePromise, autoPromise]);

    const liveBody = live.stmts.addMessage.run.mock.calls[0][3] as string;
    const autoBody = auto.stmts.addMessage.run.mock.calls[0][3] as string;
    expect(liveBody).toBe(autoBody);
  });
});
