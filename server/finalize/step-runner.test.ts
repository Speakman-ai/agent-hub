/**
 * Unit tests for the Finalize step runner (tasks phase). We use a fake
 * `spawnStep` that drives an `EventEmitter`-backed child so the streaming
 * logic exercises end-to-end without touching `bash`. The only piece of
 * real I/O is the one production-spawn test that confirms
 * {@link defaultSpawnStep} actually invokes `bash -euo pipefail -c` and
 * reports the correct exit code on a trivially-failing command (no CLI
 * binaries are involved — `bash` ships with the test image).
 */
import { spawn } from 'child_process';
import { EventEmitter, Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CiConfig, CiStep } from './ci-config.js';
import { spotReclaimDetail } from './spot-interruption.js';
import {
  STEP_OUTPUT_TAIL_LINES,
  STEP_ACTIVE_SECONDS_PER_STEP,
  STEP_POST_EXIT_FLUSH_GRACE_MS,
  STEP_KILL_SETTLE_GRACE_MS,
  REMOTE_LOSS_CONFIRM_POLL_MS,
  REMOTE_LOSS_CONFIRM_MAX_WAIT_MS,
  TASKS_PHASE_ENTRY_ACTIVE_SECONDS,
  __test,
  defaultSpawnStep,
  runStepsSequence,
  type SpawnStepFn,
  type SpawnedStep,
  type StepRunResult,
  type StepRunnerDeps,
} from './step-runner.js';
import type { RunnerJobLossProbe } from './runner-queue.js';
import type {
  FinalizeStepLogStore,
  StepLogPersist,
  StepLogSnapshot,
} from './finalize-log-store.js';

// ─── Fake log store ─────────────────────────────────────────────────
// Captures what each step would upload so tests assert on the blob the store
// receives instead of on per-line chat messages (the old contract).
function makeLogStore(): {
  store: FinalizeStepLogStore;
  writes: Array<{ runId: string; stepIndex: number; snapshot: StepLogSnapshot }>;
} {
  const writes: Array<{ runId: string; stepIndex: number; snapshot: StepLogSnapshot }> = [];
  const store: FinalizeStepLogStore = {
    write: vi.fn(async (runId: string, stepIndex: number, snapshot: StepLogSnapshot) => {
      writes.push({ runId, stepIndex, snapshot });
      return {
        storage_kind: 'local',
        storage_bucket: null,
        storage_region: null,
        key: `finalize-logs/${runId}/${stepIndex}.json.gz`,
        lines: snapshot.totalLines,
        truncated: snapshot.truncated,
      };
    }),
    read: vi.fn(async () => null),
  };
  return { store, writes };
}

// ─── Fakes ──────────────────────────────────────────────────────────

interface FakeStmts {
  getFinalizeRun: { get: ReturnType<typeof vi.fn> };
  updateFinalizeRunPhase: { run: ReturnType<typeof vi.fn> };
  updateFinalizeRunActiveSeconds: { run: ReturnType<typeof vi.fn> };
  failFinalizeRun: { run: ReturnType<typeof vi.fn> };
  addMessage: { run: ReturnType<typeof vi.fn> };
  touchSession: { run: ReturnType<typeof vi.fn> };
  getMessageById: { get: ReturnType<typeof vi.fn> };
  upsertFinalizeRunStep: { run: ReturnType<typeof vi.fn> };
  beginFinalizeRunStepAttempt: { run: ReturnType<typeof vi.fn> };
  finishFinalizeRunStepIfAttempt: { run: ReturnType<typeof vi.fn> };
  attachFinalizeRunStepLog: { run: ReturnType<typeof vi.fn> };
  listFinalizeRunStepsForRun: { all: ReturnType<typeof vi.fn> };
}

function makeStmts(): FakeStmts {
  const steps: Array<{
    step_index: number;
    name: string;
    state: string;
    exit_code: number | null;
    started_at: number | null;
    ended_at: number | null;
  }> = [];
  return {
    getFinalizeRun: { get: vi.fn().mockReturnValue({ loop_round: 1 }) },
    updateFinalizeRunPhase: { run: vi.fn() },
    updateFinalizeRunActiveSeconds: { run: vi.fn() },
    failFinalizeRun: { run: vi.fn() },
    addMessage: { run: vi.fn() },
    touchSession: { run: vi.fn() },
    upsertFinalizeRunStep: {
      run: vi.fn(
        (
          _runId: string,
          stepIndex: number,
          name: string,
          state: string,
          exitCode: number | null,
          startedAt: number | null,
          endedAt: number | null,
        ) => {
          const existing = steps.find((s) => s.step_index === stepIndex);
          const row = {
            step_index: stepIndex,
            name,
            state,
            exit_code: exitCode,
            started_at: startedAt,
            ended_at: endedAt,
          };
          if (existing) Object.assign(existing, row);
          else steps.push(row);
        },
      ),
    },
    beginFinalizeRunStepAttempt: { run: vi.fn() },
    // Mirrors the production guarded terminal write: applies only while the
    // row is `running` (nonce fidelity isn't modelled — each fake execution
    // is the row's only writer) and reports `changes` so announceStepEnd can
    // drop stale writes.
    finishFinalizeRunStepIfAttempt: {
      run: vi.fn(
        (
          state: string,
          exitCode: number | null,
          endedAt: number | null,
          _runId: string,
          stepIndex: number,
          _attempt: string,
        ) => {
          const existing = steps.find((s) => s.step_index === stepIndex);
          if (!existing || existing.state !== 'running') return { changes: 0 };
          existing.state = state;
          existing.exit_code = exitCode;
          existing.ended_at = endedAt;
          return { changes: 1 };
        },
      ),
    },
    attachFinalizeRunStepLog: { run: vi.fn() },
    listFinalizeRunStepsForRun: {
      all: vi.fn(() => [...steps].sort((a, b) => a.step_index - b.step_index)),
    },
    getMessageById: {
      get: vi.fn().mockImplementation((id: string) => ({
        id,
        session_id: 'sess-1',
        role: 'system',
        content: 'mocked',
      })),
    },
  };
}

/**
 * Build a fake spawned child. The returned `emit` is what tests call to
 * drive stdout/stderr/close in the order the production code would
 * observe.
 */
function makeFakeChild(): {
  child: SpawnedStep;
  stdout: Readable;
  stderr: Readable;
  emitter: EventEmitter;
  killed: NodeJS.Signals[];
} {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const emitter = new EventEmitter();
  const killed: NodeJS.Signals[] = [];
  const child: SpawnedStep = {
    stdout,
    stderr,
    on(event: 'close' | 'exit' | 'error', listener: (arg: never) => void) {
      emitter.on(event, listener as never);
      return child;
    },
    kill(signal?: NodeJS.Signals) {
      killed.push(signal ?? 'SIGTERM');
      return true;
    },
  };
  return { child, stdout, stderr, emitter, killed };
}

/**
 * Drive one job's step sequence from a parsed config, the way `runJobPhase`
 * does for each matrix shard. Keeps these tests reading as "run this pipeline"
 * instead of unpacking `jobs.checks` at 30 call sites.
 */
function runJobSteps(
  deps: StepRunnerDeps,
  opts: {
    runId: string;
    config: CiConfig;
    worktreePath: string;
    sessionId: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<StepRunResult> {
  return runStepsSequence(deps, {
    runId: opts.runId,
    sessionId: opts.sessionId,
    worktreePath: opts.worktreePath,
    steps: opts.config.jobs.checks.steps,
    timeoutMinutes: opts.config.timeoutMinutes,
    ...(opts.env ? { env: opts.env } : {}),
  });
}

function makeConfig(steps: CiStep[], timeoutMinutes = 60): CiConfig {
  return {
    version: 2,
    on: ['finalize'],
    timeoutMinutes,
    jobs: {
      checks: {
        runsOn: 'host',
        failFast: false,
        warmup: false,
        needs: [],
        retries: 0,
        matrixInclude: [{}],
        steps,
      },
    },
  };
}

const SESSION_ID = 'sess-1';
const RUN_ID = 'run-1';
const WORKTREE = '/tmp/finalize-step-runner-fake';

// ─── Tests ──────────────────────────────────────────────────────────

describe('runJobSteps — per-step timeout_minutes', () => {
  it('passes a step-level timeout_minutes as the spawn deadline, tightening the budget', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const seen: Array<number | undefined> = [];
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = (a) => {
      seen.push(a.deadlineMs);
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      logStore: makeLogStore().store,
      now: makeMonoClock(),
    };
    // 60-min pipeline budget; step 1 caps itself at 1 min, step 2 is uncapped.
    const config = makeConfig([
      { name: 'Capped', run: 'npm test', timeoutMinutes: 1 },
      { name: 'Uncapped', run: 'npm run lint' },
    ]);

    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });
    await microtaskTick();
    fakes[0].emitter.emit('close', 0);
    await microtaskTick();
    fakes[1].emitter.emit('close', 0);
    await resultP;

    expect(seen[0]).toBe(60_000); // 1-min per-step cap wins over the 60-min budget
    expect(seen[1]).toBeGreaterThan(60_000); // uncapped → only the pipeline budget bounds it
  });

  // Regression (reviewer feedback): a per-step timeout_minutes ABOVE the
  // defensive per-spawn hard cap must NOT raise the ceiling — it is clamped to
  // the cap. Otherwise `timeout_minutes: 120` would let a step run 2h past the
  // 60-min containment ceiling, re-opening the hang gap this change closes.
  it('clamps a step timeout_minutes above the per-spawn hard cap down to the cap', async () => {
    const stmts = makeStmts();
    const seen: Array<number | undefined> = [];
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = (a) => {
      seen.push(a.deadlineMs);
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast: vi.fn(),
      spawnStep,
      logStore: makeLogStore().store,
      now: makeMonoClock(),
      spawnHardTimeoutMs: 30_000, // 30s defensive per-spawn ceiling
    };
    // Step asks for 5 min — far above the 30s spawn cap — under a generous budget.
    const config = makeConfig([{ name: 'Long', run: 'npm run e2e', timeoutMinutes: 5 }], 60);

    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });
    await microtaskTick();
    fakes[0].emitter.emit('close', 0);
    await resultP;

    // Clamped to the 30s spawn cap, NOT the requested 300_000ms.
    expect(seen[0]).toBe(30_000);
  });
});

describe('runJobSteps — happy path', () => {
  it('runs every step sequentially, streams stdout/stderr line-by-line, returns success', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };

    const { store: logStore, writes: logWrites } = makeLogStore();
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      logStore,
      now: makeMonoClock(),
    };
    const config = makeConfig([
      { name: 'Install', run: 'npm ci' },
      { name: 'Test', run: 'npm test' },
    ]);

    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });

    // Drive step 1 — emit two complete lines split across chunks.
    await microtaskTick();
    fakes[0].stdout.push('hello\nworld');
    fakes[0].stdout.push('\nfinal');
    await microtaskTick();
    fakes[0].emitter.emit('close', 0);

    // Drive step 2 — single chunk with embedded CRLF (verifies CR stripping).
    await microtaskTick();
    fakes[1].stdout.push('line1\r\nline2\n');
    fakes[1].stderr.push('warn\n');
    await microtaskTick();
    fakes[1].emitter.emit('close', 0);

    const result = await resultP;
    expect(result.status).toBe('success');
    expect(result.failedStep).toBeUndefined();
    expect(result.stepResults).toHaveLength(2);
    expect(result.stepResults[0]).toMatchObject({
      index: 1,
      name: 'Install',
      run: 'npm ci',
      exitCode: 0,
      stdoutLines: 3, // "hello", "world", "final" — last fragment flushed on close
      stderrLines: 0,
    });
    expect(result.stepResults[1]).toMatchObject({
      index: 2,
      name: 'Test',
      run: 'npm test',
      exitCode: 0,
      stdoutLines: 2,
      stderrLines: 1,
    });

    // Phase set once at entry.
    expect(stmts.updateFinalizeRunPhase.run).toHaveBeenCalledTimes(1);
    expect(stmts.updateFinalizeRunPhase.run).toHaveBeenCalledWith('tasks', 'running', RUN_ID);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'finalize_run_phase_changed',
        run_id: RUN_ID,
        phase: 'tasks',
        status: 'running',
      }),
    );

    // Output is NO LONGER streamed into the session as per-line messages.
    // The only message is the single checks-round summary.
    expect(stmts.addMessage.run).toHaveBeenCalledTimes(1);
    const checksRoundCall = stmts.addMessage.run.mock.calls.find((call) => {
      const m = JSON.parse(call[7] as string);
      return m.kind === 'finalize_checks_round';
    });
    expect(checksRoundCall).toBeTruthy();
    expect(JSON.parse(checksRoundCall![7] as string)).toMatchObject({
      kind: 'finalize_checks_round',
      runId: RUN_ID,
      round: 1,
    });

    // Each step minted a fresh per-execution nonce + cleared any prior log
    // location on start (beginFinalizeRunStepAttempt), and the upload carried
    // that same nonce through to write().
    expect(stmts.beginFinalizeRunStepAttempt.run).toHaveBeenCalledTimes(2);
    const step1Nonce = stmts.beginFinalizeRunStepAttempt.run.mock.calls[0][0];
    const step2Nonce = stmts.beginFinalizeRunStepAttempt.run.mock.calls[1][0];
    expect(step1Nonce).toEqual(expect.any(String));
    expect(step1Nonce).not.toBe(step2Nonce);

    // Each step's output went to the log store ONCE (not the chat stream),
    // keyed by its execution nonce (the write's 4th arg).
    expect(logStore.write).toHaveBeenCalledTimes(2);
    expect(logStore.write).toHaveBeenNthCalledWith(1, RUN_ID, 1, expect.anything(), step1Nonce);
    expect(logWrites[0]).toMatchObject({ runId: RUN_ID, stepIndex: 1 });
    expect(logWrites[0].snapshot.lines).toEqual([
      { stream: 'stdout', text: 'hello' },
      { stream: 'stdout', text: 'world' },
      { stream: 'stdout', text: 'final' },
    ]);
    expect(logWrites[0].snapshot.totalLines).toBe(3);
    // Step 2's stderr warn line is captured in its blob, tagged stderr.
    expect(logWrites[1].snapshot.lines).toContainEqual({ stream: 'stderr', text: 'warn' });

    // Only the checks-round summary broadcasts a `message` — no output flood.
    const messageBroadcasts = broadcast.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type?: string }).type === 'message',
    );
    expect(messageBroadcasts).toHaveLength(1);

    // step_state events: 2 starts + 2 passes = 4
    const stepStates = broadcast.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type?: string }).type === 'finalize_run_step_state',
    );
    expect(stepStates).toHaveLength(4);
    expect(stepStates[0][0]).toMatchObject({
      run_id: RUN_ID,
      step_index: 1,
      state: 'running',
    });
    expect(stepStates[1][0]).toMatchObject({
      run_id: RUN_ID,
      step_index: 1,
      state: 'passed',
      exit_code: 0,
    });

    // Active seconds billed: 1 entry + 2 steps × 5 = 11.
    expect(result.activeSecondsBilled).toBe(
      TASKS_PHASE_ENTRY_ACTIVE_SECONDS + 2 * STEP_ACTIVE_SECONDS_PER_STEP,
    );
    expect(stmts.updateFinalizeRunActiveSeconds.run).toHaveBeenCalledTimes(3);
  });
});

describe('runJobSteps — failure short-circuits', () => {
  it('non-zero exit on step N stops the pipeline and surfaces failedStep', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    let spawnCount = 0;
    const spawnStep: SpawnStepFn = () => {
      spawnCount += 1;
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      now: makeMonoClock(),
    };
    const config = makeConfig([
      { name: 'Install', run: 'npm ci' },
      { name: 'Typecheck', run: 'npm run typecheck' },
      { name: 'Test', run: 'npm test' },
    ]);

    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });

    // Step 1 passes.
    await microtaskTick();
    fakes[0].stdout.push('installed\n');
    await microtaskTick();
    fakes[0].emitter.emit('close', 0);

    // Step 2 fails with exit 2.
    await microtaskTick();
    fakes[1].stderr.push('error TS2304: cannot find name "Foo"\n');
    fakes[1].stdout.push('Found 1 error\n');
    await microtaskTick();
    fakes[1].emitter.emit('close', 2);

    const result = await resultP;
    expect(result.status).toBe('failure');
    expect(result.failedStep).toBeDefined();
    expect(result.failedStep).toMatchObject({
      index: 2,
      name: 'Typecheck',
      run: 'npm run typecheck',
      exitCode: 2,
    });
    expect(result.failedStep!.outputTail).toEqual(
      ['[stderr] error TS2304: cannot find name "Foo"', '[stdout] Found 1 error']
        .map(stripPrefixForTail)
        .map((s, i) =>
          // The tail keeps the raw line (no [stdout]/[stderr] prefix) so the
          // dispatch body in §7 isn't double-prefixed when it renders the
          // tail in its own code fence.
          i === 0 ? 'error TS2304: cannot find name "Foo"' : 'Found 1 error',
        ),
    );

    // Step 3 must NOT have been spawned.
    expect(spawnCount).toBe(2);

    // Accumulated `stepResults` survives the short-circuit — both step 1
    // (passed) and step 2 (failed) appear in declaration order. This is
    // the regression contract for #1: `terminate()` used to return an
    // empty array regardless of how many steps had run.
    expect(result.stepResults).toHaveLength(2);
    expect(result.stepResults[0]).toMatchObject({
      index: 1,
      name: 'Install',
      run: 'npm ci',
      exitCode: 0,
    });
    expect(result.stepResults[1]).toMatchObject({
      index: 2,
      name: 'Typecheck',
      run: 'npm run typecheck',
      exitCode: 2,
    });

    // Terminal failure persisted.
    expect(stmts.failFinalizeRun.run).toHaveBeenCalledWith('failed', 'step_failed', RUN_ID);

    // step_state for step 2 = failed; no events for step 3.
    const stepStates = broadcast.mock.calls
      .filter((c: unknown[]) => (c[0] as { type?: string }).type === 'finalize_run_step_state')
      .map((c: unknown[]) => c[0]) as Array<{
      step_index: number;
      state: string;
      exit_code?: number;
    }>;
    expect(stepStates.map((s) => s.step_index)).toEqual([1, 1, 2, 2]);
    expect(stepStates[3]).toMatchObject({ step_index: 2, state: 'failed', exit_code: 2 });

    // Only 2 step costs billed + entry.
    expect(result.activeSecondsBilled).toBe(
      TASKS_PHASE_ENTRY_ACTIVE_SECONDS + 2 * STEP_ACTIVE_SECONDS_PER_STEP,
    );
  });

  it('captures negative-exit (null code → -1) as failure', async () => {
    const stmts = makeStmts();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast: vi.fn(),
      spawnStep,
      now: makeMonoClock(),
    };
    const config = makeConfig([{ name: 'step 1', run: 'kill -9 $$' }]);

    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });
    await microtaskTick();
    fakes[0].emitter.emit('close', null);

    const result = await resultP;
    expect(result.status).toBe('failure');
    expect(result.failedStep!.exitCode).toBe(-1);
  });
});

describe('runJobSteps — runner teardown (context canceled) reclassifies to infra_error', () => {
  it('a non-zero exit ending in the context-canceled sentinel (all tests green) → infra_error, not step_failed', async () => {
    const stmts = makeStmts();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast: vi.fn(),
      spawnStep,
      now: makeMonoClock(),
    };
    const config = makeConfig([{ name: 'Tests (client)', run: 'npm test' }]);

    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });

    await microtaskTick();
    // Every test passes, then the runner is torn down mid-exec: the docker CLI
    // prints Go's context.Canceled sentinel and the exec exits non-zero.
    fakes[0].stdout.push('✓ src/components/MyCodexAuthSection.test.tsx (4 tests)\n');
    fakes[0].stderr.push('context canceled\n');
    await microtaskTick();
    fakes[0].emitter.emit('close', 1);

    const result = await resultP;
    // Routed to the infra class so the orchestrator's one-auto-retry re-runs
    // on a fresh runner — NO wasted fix round dispatched to the agent. The
    // strict terminal-sentinel detector (runner-teardown.ts) owns this case and
    // tags it container_unavailable.
    expect(result.status).toBe('infra_error');
    expect(result.failureReason).toBe('container_unavailable');
    // Contract: infra_error must NOT persist a terminal status — the
    // orchestrator owns the retry-vs-fail decision.
    expect(stmts.failFinalizeRun.run).not.toHaveBeenCalled();
    // failedStep is still carried for diagnostics.
    expect(result.failedStep).toBeDefined();
    expect(result.failedStep!.name).toBe('Tests (client)');
  });

  it('a REAL test failure that also logs context canceled stays CI-class (step_failed)', async () => {
    const stmts = makeStmts();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast: vi.fn(),
      spawnStep,
      now: makeMonoClock(),
    };
    const config = makeConfig([{ name: 'Tests (client)', run: 'npm test' }]);

    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });

    await microtaskTick();
    // A genuine red: the vitest failure summary is present, so even with a
    // trailing context-canceled teardown line this must NOT be reclassified by
    // EITHER detector — the shared hasTestFailureSummary guardrail keeps it red.
    fakes[0].stdout.push('FAIL src/components/Foo.test.tsx\n');
    fakes[0].stdout.push('Tests  3 failed | 900 passed (903)\n');
    fakes[0].stderr.push('context canceled\n');
    await microtaskTick();
    fakes[0].emitter.emit('close', 1);

    const result = await resultP;
    expect(result.status).toBe('failure');
    expect(stmts.failFinalizeRun.run).toHaveBeenCalledWith('failed', 'step_failed', RUN_ID);
  });
});

describe('runJobSteps — workspace-permission (EACCES) reclassifies to infra_error', () => {
  it('an install step dying with EACCES on /github/workspace → infra `runner_workspace_unwritable`, not step_failed', async () => {
    const stmts = makeStmts();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast: vi.fn(),
      spawnStep,
      now: makeMonoClock(),
    };
    const config = makeConfig([{ name: 'Install root dependencies', run: 'npm ci' }]);

    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });

    await microtaskTick();
    // The bind-mounted worktree is owned by a uid the `runner` user can't write:
    // npm ci dies immediately at the install step. No branch edit can fix this.
    fakes[0].stderr.push('npm error code EACCES\n');
    fakes[0].stderr.push('npm error syscall mkdir\n');
    fakes[0].stderr.push('npm error path /github/workspace/node_modules\n');
    fakes[0].stderr.push('npm error errno -13\n');
    fakes[0].stderr.push(
      "npm error Error: EACCES: permission denied, mkdir '/github/workspace/node_modules'\n",
    );
    await microtaskTick();
    fakes[0].emitter.emit('close', 243);

    const result = await resultP;
    // Infra-class so the orchestrator's auto-retry re-runs on a fresh runner
    // instead of the fix loop chasing an unfixable red into `fix_no_progress`.
    expect(result.status).toBe('infra_error');
    expect(result.failureReason).toBe('runner_workspace_unwritable');
    // Contract: infra_error must NOT persist a terminal status — the orchestrator
    // owns the retry-vs-fail decision.
    expect(stmts.failFinalizeRun.run).not.toHaveBeenCalled();
    expect(result.failedStep).toBeDefined();
    expect(result.failedStep!.name).toBe('Install root dependencies');
  });

  it('a real test failure that also prints an EACCES workspace path stays CI-class (step_failed)', async () => {
    const stmts = makeStmts();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast: vi.fn(),
      spawnStep,
      now: makeMonoClock(),
    };
    const config = makeConfig([{ name: 'Tests (server)', run: 'npm test' }]);

    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });

    await microtaskTick();
    // A genuine red whose assertion output happens to mention an EACCES workspace
    // path: the vitest failure summary must keep it CI-class via the shared
    // hasTestFailureSummary guardrail.
    fakes[0].stdout.push('FAIL src/fs.test.ts\n');
    fakes[0].stdout.push(
      "AssertionError: expected write to succeed, got EACCES '/github/workspace/x'\n",
    );
    fakes[0].stdout.push('Tests  1 failed | 40 passed (41)\n');
    await microtaskTick();
    fakes[0].emitter.emit('close', 1);

    const result = await resultP;
    expect(result.status).toBe('failure');
    expect(stmts.failFinalizeRun.run).toHaveBeenCalledWith('failed', 'step_failed', RUN_ID);
  });
});

describe('runJobSteps — runner cancellation collateral', () => {
  it('reclassifies a `context canceled` non-zero exit as infra `runner_cancelled` (not step_failed)', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      now: makeMonoClock(),
    };
    const config = makeConfig([
      { name: 'E2E', run: 'docker compose up --abort-on-container-exit' },
    ]);

    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });

    await microtaskTick();
    // The inner dockerd is torn down mid-run: the Go CLI prints the canonical
    // context-canceled error and the process exits 1. The strict
    // terminal-sentinel detector rejects this (the sentinel is not the bare
    // terminal line), so the broader collateral detector catches it.
    fakes[0].stderr.push(
      'error during connect: Get "http://docker.sock/v1.45/info": context canceled\n',
    );
    await microtaskTick();
    fakes[0].emitter.emit('close', 1);

    const result = await resultP;

    // Infra-class, NOT a genuine `step_failed` red the fix loop would chase.
    expect(result.status).toBe('infra_error');
    expect(result.failureReason).toBe('runner_cancelled');
    // No terminal `failed`/`timed_out` write — infra terminals are owned by the
    // orchestrator's retry path.
    expect(stmts.failFinalizeRun.run).not.toHaveBeenCalled();
    // The failing step is still surfaced so the UI/log viewer can show it.
    expect(result.failedStep).toMatchObject({ index: 1, name: 'E2E', exitCode: 1 });
  });

  it('leaves a genuine test failure that merely mentions "context canceled" mid-output as step_failed', async () => {
    const stmts = makeStmts();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast: vi.fn(),
      spawnStep,
      now: makeMonoClock(),
    };
    const config = makeConfig([{ name: 'Test', run: 'npm test' }]);

    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });

    await microtaskTick();
    fakes[0].stdout.push('handler logged: context canceled\n');
    fakes[0].stdout.push('AssertionError: expected 200 but got 500\n');
    fakes[0].stdout.push('1 failing\n');
    await microtaskTick();
    fakes[0].emitter.emit('close', 1);

    const result = await resultP;
    expect(result.status).toBe('failure');
    expect(stmts.failFinalizeRun.run).toHaveBeenCalledWith('failed', 'step_failed', RUN_ID);
  });
});

describe('runJobSteps — timeout (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hard-spawn timeout kills the child and surfaces timeout outcome', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      now: () => Date.now(),
      spawnHardTimeoutMs: 100,
    };
    const config = makeConfig([{ name: 'sleeper', run: 'sleep 9999' }]);

    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });
    await Promise.resolve();
    // Advance time past the spawn timeout. The runner will SIGTERM, then
    // SIGKILL after the 1s grace. We finish by emitting close ourselves
    // (the kill itself doesn't fire close in our fake).
    await vi.advanceTimersByTimeAsync(150);
    fakes[0].emitter.emit('close', 143); // 128 + SIGTERM
    await Promise.resolve();

    const result = await resultP;
    expect(result.status).toBe('timeout');
    expect(result.failedStep).toBeDefined();
    expect(result.failedStep!.name).toBe('sleeper');
    expect(fakes[0].killed[0]).toBe('SIGTERM');
    expect(stmts.failFinalizeRun.run).toHaveBeenCalledWith('timed_out', 'timeout', RUN_ID);
  });

  // Regression: the 4h stranded-shard bug. A REMOTE step whose runner-agent is
  // dead never emits close/exit/error after kill() (kill only queues a `cancel`
  // the dead agent can't read), so the step promise used to hang forever and the
  // run sat `running` indefinitely. The hard-timeout backstop must force-settle
  // the step as `timeout` even when NO terminal event ever arrives.
  it('force-settles as timeout when the child never emits close/exit after kill (dead remote agent)', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      now: () => Date.now(),
      spawnHardTimeoutMs: 100,
    };
    const config = makeConfig([{ name: 'sleeper', run: 'sleep 9999' }]);

    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });
    await Promise.resolve();
    // Advance past the hard timeout (100ms), the 1s SIGKILL grace, and the
    // force-settle grace — WITHOUT ever emitting close/exit/error, exactly as a
    // dead remote runner would behave.
    await vi.advanceTimersByTimeAsync(100 + 1_000 + STEP_KILL_SETTLE_GRACE_MS + 100);

    const result = await resultP;
    expect(result.status).toBe('timeout');
    expect(result.failedStep).toBeDefined();
    expect(result.failedStep!.name).toBe('sleeper');
    // Both signals were attempted (they no-op against a dead remote), and the
    // run still terminated instead of hanging.
    expect(fakes[0].killed).toContain('SIGTERM');
    expect(fakes[0].killed).toContain('SIGKILL');
    expect(stmts.failFinalizeRun.run).toHaveBeenCalledWith('timed_out', 'timeout', RUN_ID);
  });
});

// A force-settling REMOTE step is ambiguous: genuine overrun on a live runner
// (CI-class `timeout`, parked) vs. the runner dying underneath the step (Spot
// reclaim / crash — infra-class, retried on a fresh agent). When the step
// carries a runner-loss probe (remote backend), the settlement must consult it
// instead of blindly parking the run as timed_out — that blind park is exactly
// how a Spot death used to burn a green change set.
describe('runJobSteps — loss-aware remote timeout classification (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function runWithProbe(probe: () => RunnerJobLossProbe | null) {
    const stmts = makeStmts();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      f.child.probeRunnerLoss = probe;
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast: vi.fn(),
      spawnStep,
      now: () => Date.now(),
      spawnHardTimeoutMs: 100,
    };
    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config: makeConfig([{ name: 'sleeper', run: 'sleep 9999' }]),
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });
    return { stmts, fakes, resultP };
  }

  const evidence = (over: Partial<RunnerJobLossProbe> = {}): RunnerJobLossProbe => ({
    state: 'running',
    lost: false,
    leaseExpired: false,
    spotInterrupted: false,
    heartbeatAt: 0,
    detail: null,
    ...over,
  });

  it('a spot-interrupted runner reclassifies the timeout as spot_reclaimed (infra, retried)', async () => {
    const { stmts, resultP } = runWithProbe(() =>
      evidence({ state: 'lost', lost: true, spotInterrupted: true, detail: 'lease expired' }),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100 + 1_000 + STEP_KILL_SETTLE_GRACE_MS + 100);

    const result = await resultP;
    expect(result.status).toBe('infra_error');
    expect(result.failureReason).toBe('spot_reclaimed');
    // Infra-class: the orchestrator owns the retry — no CI-terminal DB write.
    expect(stmts.failFinalizeRun.run).not.toHaveBeenCalled();
  });

  it('a lease-expired runner (reaper tick pending) reclassifies as container_unavailable', async () => {
    const { stmts, resultP } = runWithProbe(() => evidence({ leaseExpired: true }));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100 + 1_000 + STEP_KILL_SETTLE_GRACE_MS + 100);

    const result = await resultP;
    expect(result.status).toBe('infra_error');
    expect(result.failureReason).toBe('container_unavailable');
    expect(stmts.failFinalizeRun.run).not.toHaveBeenCalled();
  });

  it('a live runner (heartbeat newer than the kill) keeps the genuine timeout classification', async () => {
    // First probe tick: heartbeat older than the kill (inconclusive) → the
    // confirm loop must poll again rather than settle. Second tick: a fresh
    // heartbeat proves the agent is alive → genuine overrun → timeout.
    let heartbeatAt = 0;
    const { stmts, resultP } = runWithProbe(() => evidence({ heartbeatAt }));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100 + 1_000 + STEP_KILL_SETTLE_GRACE_MS + 100);
    heartbeatAt = Date.now() + 1; // newer than the kill timestamp
    await vi.advanceTimersByTimeAsync(REMOTE_LOSS_CONFIRM_POLL_MS + 100);

    const result = await resultP;
    expect(result.status).toBe('timeout');
    expect(stmts.failFinalizeRun.run).toHaveBeenCalledWith('timed_out', 'timeout', RUN_ID);
  });

  it('inconclusive evidence settles as timeout once the max confirm wait elapses', async () => {
    // Heartbeat never advances and the lease never expires (e.g. a wedged
    // agent whose heartbeat loop also died but whose row was hand-edited) —
    // the conservative direction is a genuine timeout, never a hidden retry.
    const { resultP } = runWithProbe(() => evidence({ heartbeatAt: 0 }));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(
      100 +
        1_000 +
        STEP_KILL_SETTLE_GRACE_MS +
        REMOTE_LOSS_CONFIRM_MAX_WAIT_MS +
        REMOTE_LOSS_CONFIRM_POLL_MS +
        100,
    );

    const result = await resultP;
    expect(result.status).toBe('timeout');
  });

  it('a missing queue row (probe null) settles immediately as timeout (old behavior)', async () => {
    const { resultP } = runWithProbe(() => null);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100 + 1_000 + STEP_KILL_SETTLE_GRACE_MS + 100);

    const result = await resultP;
    expect(result.status).toBe('timeout');
  });
});

describe('runJobSteps — exit without close (leaked-grandchild pipe)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('force-settles a successful step on exit when close never fires', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      now: () => Date.now(),
    };
    const config = makeConfig([{ name: 'Typecheck', run: 'npm run typecheck' }]);

    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });
    await vi.advanceTimersByTimeAsync(0);
    fakes[0].stdout.emit('data', Buffer.from('buffered-before-exit'));
    fakes[0].emitter.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(STEP_POST_EXIT_FLUSH_GRACE_MS + 10);

    const result = await resultP;
    expect(result.status).toBe('success');
    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0]).toMatchObject({
      name: 'Typecheck',
      exitCode: 0,
      stdoutLines: 1,
    });
    expect(fakes[0].stdout.listenerCount('data')).toBe(0);
    expect(fakes[0].stderr.listenerCount('data')).toBe(0);
    expect(fakes[0].stdout.destroyed).toBe(true);
    expect(fakes[0].stderr.destroyed).toBe(true);
  });

  it('settles from close when it arrives within the grace window', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      now: () => Date.now(),
    };
    const config = makeConfig([{ name: 'Build', run: 'npm run build' }]);

    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });
    await vi.advanceTimersByTimeAsync(0);
    fakes[0].emitter.emit('exit', 2);
    await vi.advanceTimersByTimeAsync(STEP_POST_EXIT_FLUSH_GRACE_MS / 2);
    fakes[0].emitter.emit('close', 2);
    await vi.advanceTimersByTimeAsync(STEP_POST_EXIT_FLUSH_GRACE_MS);

    const result = await resultP;
    expect(result.status).toBe('failure');
    expect(result.failedStep).toMatchObject({ name: 'Build', exitCode: 2 });
  });

  it('force-settles a timed-out step on exit when close never fires after SIGKILL', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      now: () => Date.now(),
      spawnHardTimeoutMs: 100,
    };
    const config = makeConfig([{ name: 'sleeper', run: 'sleep 9999' }]);

    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_200);
    fakes[0].emitter.emit('exit', null);
    await vi.advanceTimersByTimeAsync(STEP_POST_EXIT_FLUSH_GRACE_MS + 10);

    const result = await resultP;
    expect(result.status).toBe('timeout');
    expect(result.failedStep!.name).toBe('sleeper');
    expect(fakes[0].killed[0]).toBe('SIGTERM');
  });
});

describe('runJobSteps — timeout (real timers)', () => {
  it('pipeline budget exhausted before step N surfaces timeout with the unexecuted step', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    let nowMs = 1_000;
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      // Each spawn advances the clock past the budget.
      nowMs += 70_000;
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      now: () => nowMs,
    };
    // 1-minute budget; step 1 will use it all, step 2 won't get to run.
    const config = makeConfig(
      [
        { name: 'eager', run: 'echo hi' },
        { name: 'skipped', run: 'echo nope' },
      ],
      1,
    );

    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });
    await microtaskTick();
    fakes[0].emitter.emit('close', 0);
    await microtaskTick();

    const result = await resultP;
    expect(result.status).toBe('timeout');
    expect(result.failedStep).toMatchObject({
      index: 2,
      name: 'skipped',
      exitCode: -1,
    });
    expect(result.failedStep!.outputTail[0]).toContain('budget exhausted');
    expect(stmts.failFinalizeRun.run).toHaveBeenCalledWith('timed_out', 'timeout', RUN_ID);

    // Step 1 ran cleanly before the budget was burned — its StepResult
    // must survive the terminate() call. Step 2 never ran (we hit the
    // pre-spawn budget check), so only one entry should be present.
    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0]).toMatchObject({
      index: 1,
      name: 'eager',
      run: 'echo hi',
      exitCode: 0,
    });
  });
});

describe('runJobSteps — spawn errors', () => {
  it('spawnStep throws → infra_error (no DB terminal write; orchestrator owns retry)', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const spawnStep: SpawnStepFn = () => {
      throw new Error('ENOENT bash not found');
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      now: makeMonoClock(),
    };
    const config = makeConfig([{ name: 'step 1', run: 'echo hi' }]);

    const result = await runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });
    expect(result.status).toBe('infra_error');
    expect(result.infraErrorDetail).toContain('ENOENT bash not found');
    expect(result.failedStep!.exitCode).toBe(-1);
    // Contract (review #2): infra_error must NOT call failFinalizeRun
    // here — the design (§10) reserves the infra class for an automatic
    // one-shot retry, and a terminal DB write would make that retry path
    // unreachable. The orchestrator decides retry vs. give-up.
    expect(stmts.failFinalizeRun.run).not.toHaveBeenCalled();
  });

  it('child emits error event → infra_error (no DB terminal write; orchestrator owns retry)', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      now: makeMonoClock(),
    };
    const config = makeConfig([{ name: 'step 1', run: 'echo hi' }]);

    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });
    await microtaskTick();
    fakes[0].emitter.emit('error', new Error('runtime panic'));
    await microtaskTick();

    const result = await resultP;
    expect(result.status).toBe('infra_error');
    expect(result.infraErrorDetail).toBe('runtime panic');
    expect(stmts.failFinalizeRun.run).not.toHaveBeenCalled();
  });

  it('spawn-error mid-pipeline still surfaces prior step results to the orchestrator', async () => {
    // Reinforces #1: even an infra_error on step 2 must not erase the
    // StepResult of a step 1 that ran cleanly. The orchestrator needs
    // those rows to render the checks panel (passed step 1 + the spawn
    // failure on step 2) on retry.
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    let calls = 0;
    const spawnStep: SpawnStepFn = () => {
      calls += 1;
      if (calls === 2) {
        throw new Error('container_unavailable: out of pids');
      }
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      now: makeMonoClock(),
    };
    const config = makeConfig([
      { name: 'first', run: 'echo a' },
      { name: 'doomed', run: 'echo b' },
    ]);
    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });
    await microtaskTick();
    fakes[0].emitter.emit('close', 0);
    await microtaskTick();

    const result = await resultP;
    expect(result.status).toBe('infra_error');
    expect(result.stepResults).toHaveLength(2);
    expect(result.stepResults[0]).toMatchObject({ index: 1, name: 'first', exitCode: 0 });
    expect(result.stepResults[1]).toMatchObject({ index: 2, name: 'doomed', exitCode: -1 });
    expect(stmts.failFinalizeRun.run).not.toHaveBeenCalled();
  });

  it('classifies a generic spawn-error as container_unavailable', async () => {
    const stmts = makeStmts();
    const spawnStep: SpawnStepFn = () => {
      throw new Error('runner agent lost — lease expired with no heartbeat');
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast: vi.fn(),
      spawnStep,
      now: makeMonoClock(),
    };
    const result = await runJobSteps(deps, {
      runId: RUN_ID,
      config: makeConfig([{ name: 'step 1', run: 'echo hi' }]),
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });
    expect(result.status).toBe('infra_error');
    expect(result.failureReason).toBe('container_unavailable');
  });

  it('classifies a spot-reclaim-marked spawn-error as spot_reclaimed', async () => {
    // The fleet reaper fails the in-flight step channel with the spot_reclaimed
    // marker when the runner reported an EC2 Spot interruption before its lease
    // expired. step-runner must lift that into the spot_reclaimed failure_reason
    // so the orchestrator earns the generous reclaim retry cap. This is the
    // regression that would have caught the original mis-classification.
    const stmts = makeStmts();
    const spawnStep: SpawnStepFn = () => {
      throw new Error(spotReclaimDetail('runner agent lost after an EC2 Spot interruption notice'));
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast: vi.fn(),
      spawnStep,
      now: makeMonoClock(),
    };
    const result = await runJobSteps(deps, {
      runId: RUN_ID,
      config: makeConfig([{ name: 'step 1', run: 'echo hi' }]),
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });
    expect(result.status).toBe('infra_error');
    expect(result.failureReason).toBe('spot_reclaimed');
    // Still infra-class: the orchestrator never persists infra_error itself.
    expect(stmts.failFinalizeRun.run).not.toHaveBeenCalled();
  });
});

describe('runStepsSequence — resilience', () => {
  it('log store write failure does not abort the step', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const logStore: FinalizeStepLogStore = {
      write: vi.fn(async () => {
        throw new Error('s3 unavailable');
      }),
      read: vi.fn(async () => null),
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      logStore,
      now: makeMonoClock(),
    };
    const config = makeConfig([{ name: 'step 1', run: 'echo hi' }]);
    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });
    await microtaskTick();
    fakes[0].stdout.push('hi\nbye\n');
    await microtaskTick();
    fakes[0].emitter.emit('close', 0);
    const result = await resultP;
    // A storage hiccup must not fail an otherwise-green step.
    expect(result.status).toBe('success');
    expect(logStore.write).toHaveBeenCalledTimes(1);
  });
});

describe('runJobSteps — output tail capping', () => {
  it('tail keeps only the last STEP_OUTPUT_TAIL_LINES lines mixed across stdout+stderr', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      now: makeMonoClock(),
    };
    const config = makeConfig([{ name: 'noisy', run: 'noisy' }]);
    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });
    await microtaskTick();
    // Push 100 lines on stdout, then fail.
    let blob = '';
    for (let i = 0; i < 100; i += 1) blob += `line ${i}\n`;
    fakes[0].stdout.push(blob);
    await microtaskTick();
    fakes[0].emitter.emit('close', 1);
    const result = await resultP;
    expect(result.status).toBe('failure');
    expect(result.failedStep!.outputTail).toHaveLength(STEP_OUTPUT_TAIL_LINES);
    // First retained line is line(100 - 40) = line 60; last is line 99.
    expect(result.failedStep!.outputTail[0]).toBe('line 60');
    expect(result.failedStep!.outputTail.at(-1)).toBe('line 99');
  });

  it('flushes a trailing fragment without a newline on close', async () => {
    const stmts = makeStmts();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const { store: logStore, writes: logWrites } = makeLogStore();
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast: vi.fn(),
      spawnStep,
      logStore,
      now: makeMonoClock(),
    };
    const config = makeConfig([{ name: 'step 1', run: 'no-newline' }]);
    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });
    await microtaskTick();
    fakes[0].stdout.push('only fragment, no newline');
    await microtaskTick();
    fakes[0].emitter.emit('close', 0);
    const result = await resultP;
    expect(result.status).toBe('success');
    expect(result.stepResults[0].stdoutLines).toBe(1);
    // The trailing fragment should land in the stored log blob.
    expect(logWrites[0].snapshot.lines).toContainEqual({
      stream: 'stdout',
      text: 'only fragment, no newline',
    });
  });
});

describe('BoundedLineTail', () => {
  it('grows up to cap then drops oldest', () => {
    const tail = new __test.BoundedLineTail(3);
    tail.push('a');
    tail.push('b');
    tail.push('c');
    expect(tail.snapshot()).toEqual(['a', 'b', 'c']);
    tail.push('d');
    expect(tail.snapshot()).toEqual(['b', 'c', 'd']);
    tail.push('e');
    expect(tail.snapshot()).toEqual(['c', 'd', 'e']);
  });
  it('snapshot returns a fresh array', () => {
    const tail = new __test.BoundedLineTail(2);
    tail.push('x');
    const snap = tail.snapshot();
    snap.push('mutated');
    expect(tail.snapshot()).toEqual(['x']);
  });
});

describe('FAILURE_SIGNAL_RE', () => {
  const re = () => new RegExp(__test.FAILURE_SIGNAL_RE.source);

  it('matches common test/build failure markers', () => {
    for (const line of [
      '  1 failing',
      '  1) mlsWorkflow',
      'FAIL server/foo.test.ts',
      '1) should complete the mls workflow:',
      'CypressError: Timed out retrying after 10050ms',
      'is not visible because its parent',
      'AssertionError: expected true to be false',
      'error TS2304: Cannot find name foo',
      'db-1  | 2026-06-04 16:41:59.469 UTC [941] FATAL:  database "testing123" does not exist',
      'npm ERR! code ELIFECYCLE',
    ]) {
      expect(re().test(line), line).toBe(true);
    }
  });

  it('does not match benign sidecar / info chatter', () => {
    for (const line of [
      'db-1  | 2026-06-04 16:33:34.824 UTC [53] LOG:  database system was shut down',
      'db-1  | 2026-06-04 16:38:27.272 UTC [67] LOG:  checkpoint complete: wrote 44 buffers',
      'db-1  | server started',
      'db-1  | CREATE DATABASE',
      'db-1  | PostgreSQL init process complete; ready for start up.',
      'Container webapp-api-1 Started',
      '0 passing (4m)',
    ]) {
      expect(re().test(line), line).toBe(false);
    }
  });
});

describe('FailureExcerptCollector', () => {
  it('returns empty when no failure signal was seen', () => {
    const c = new __test.FailureExcerptCollector(2, 2, 50);
    c.push('all good');
    c.push('still fine');
    expect(c.snapshot()).toEqual([]);
  });

  it('captures leading context, the signal line, and trailing context', () => {
    const c = new __test.FailureExcerptCollector(2, 2, 50);
    c.push('ctx -2');
    c.push('ctx -1');
    c.push('1 failing here');
    c.push('after 1');
    c.push('after 2');
    expect(c.snapshot()).toEqual(['ctx -2', 'ctx -1', '1 failing here', 'after 1', 'after 2']);
  });

  it('keeps the real failure even when a chatty sidecar floods the tail afterward', () => {
    const before = 8;
    const after = 30;
    const c = new __test.FailureExcerptCollector(before, after, 160);

    // The actual Cypress failure...
    const cypress = [
      '1) should complete the mls workflow',
      '0 passing (4m)',
      '1 failing',
      'CypressError: Timed out retrying after 10050ms: `cy.click()` failed because this element is not visible',
      'Fix this problem, or use `{force: true}` to disable error checking.',
    ];
    for (const l of cypress) c.push(l);

    // ...then a Postgres sidecar dumps 200 lines of benign checkpoint noise.
    for (let i = 0; i < 200; i += 1) {
      c.push(
        `db-1  | 2026-06-04 16:4${i % 9}:00 UTC [67] LOG:  checkpoint complete: wrote 3 buffers`,
      );
    }

    const excerpt = c.snapshot().join('\n');
    // A fixed trailing tail would be 100% checkpoint noise here; the excerpt
    // still surfaces the Cypress failure.
    expect(excerpt).toContain('1 failing');
    expect(excerpt).toContain('CypressError');
    expect(excerpt).toContain('this element is not visible');
  });

  it('bounds the excerpt to maxLines, dropping oldest (biases to most recent failure)', () => {
    const c = new __test.FailureExcerptCollector(0, 0, 3);
    c.push('Error: one');
    c.push('Error: two');
    c.push('Error: three');
    c.push('Error: four');
    expect(c.snapshot()).toEqual(['Error: two', 'Error: three', 'Error: four']);
  });

  it('does not duplicate context when a second failure region is contiguous', () => {
    const c = new __test.FailureExcerptCollector(2, 1, 50);
    c.push('a'); // leading context for region 1
    c.push('1 failing'); // region 1 signal
    c.push('b'); // region 1 trailing context (after=1)
    c.push('2 failing'); // region 2 signal, immediately after region 1
    const snap = c.snapshot();
    // 'a' and 'b' were already captured by region 1 — they must not reappear
    // as leading context for region 2, and no gap separator is warranted.
    expect(snap).toEqual(['a', '1 failing', 'b', '2 failing']);
    expect(new Set(snap).size).toBe(snap.length);
  });

  it('marks a gap with a separator and seeds the intervening context', () => {
    const c = new __test.FailureExcerptCollector(2, 1, 50);
    c.push('1 failing'); // region 1 (no leading context available)
    c.push('trailing-1'); // region 1 trailing context (after=1)
    c.push('noise-1'); // uncaptured gap lines...
    c.push('noise-2');
    c.push('noise-3');
    c.push('2 failing'); // region 2 — preceded by separator + last `before` noise lines
    expect(c.snapshot()).toEqual([
      '1 failing',
      'trailing-1',
      '   …',
      'noise-2',
      'noise-3',
      '2 failing',
    ]);
  });
});

describe('stripCarriageReturn', () => {
  it('strips a single trailing CR only', () => {
    expect(__test.stripCarriageReturn('hello\r')).toBe('hello');
    expect(__test.stripCarriageReturn('hello')).toBe('hello');
    expect(__test.stripCarriageReturn('a\r\r')).toBe('a\r');
  });
});

describe('defaultSpawnStep — production wiring', () => {
  // Exercise the real spawn with /usr/bin/bash. We use `bash` itself,
  // which is the production target — not one of the forbidden CLI
  // binaries (claude/cursor/gemini/codex), so the test setup guard does
  // not fire here. (Verified manually: `bash` is not in the no-real-cli
  // allowlist denylist.)
  it('runs `bash -euo pipefail -c <run>` and reports the exit code', async () => {
    // Confirm bash is available (every CI image has it). If not, skip.
    const available = await new Promise<boolean>((resolve) => {
      try {
        const probe = spawn('bash', ['-c', 'exit 0'], { stdio: 'ignore' });
        probe.on('close', (code) => resolve(code === 0));
        probe.on('error', () => resolve(false));
      } catch {
        resolve(false);
      }
    });
    if (!available) return;

    const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve) => {
        const child = defaultSpawnStep({
          step: {
            name: 'probe',
            run: 'echo "hi from stdout"; echo "hi from stderr" >&2; exit 7',
          },
          index: 1,
          cwd: process.cwd(),
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (b: Buffer) => (stdout += b.toString()));
        child.stderr?.on('data', (b: Buffer) => (stderr += b.toString()));
        child.on('close', (code: number | null) => resolve({ code: code ?? -1, stdout, stderr }));
      },
    );
    expect(result.code).toBe(7);
    expect(result.stdout).toContain('hi from stdout');
    expect(result.stderr).toContain('hi from stderr');
  });

  it('honors -euo pipefail (failing pipe component terminates the step)', async () => {
    const available = await new Promise<boolean>((resolve) => {
      try {
        const probe = spawn('bash', ['-c', 'exit 0'], { stdio: 'ignore' });
        probe.on('close', (code) => resolve(code === 0));
        probe.on('error', () => resolve(false));
      } catch {
        resolve(false);
      }
    });
    if (!available) return;

    const code = await new Promise<number>((resolve) => {
      const child = defaultSpawnStep({
        step: { name: 'pipefail probe', run: 'false | cat; echo unreachable' },
        index: 1,
        cwd: process.cwd(),
      });
      child.stdout?.on('data', () => {});
      child.stderr?.on('data', () => {});
      child.on('close', (c: number | null) => resolve(c ?? -1));
    });
    // `false | cat` → `false`'s exit = 1, pipefail propagates it, set -e
    // halts the script before the `echo unreachable` line ever fires.
    expect(code).toBe(1);
  });
});

// ─── Helpers ────────────────────────────────────────────────────────

function makeMonoClock(): () => number {
  let t = 1_000;
  return () => {
    t += 10;
    return t;
  };
}

/**
 * Flush microtasks so the runner has a chance to wire `on('data')` and
 * `on('close')` before the test pushes data / emits events. The fake
 * streams + emitter are synchronous, so a single tick is enough.
 */
function microtaskTick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

// Decorative no-op so the test asserts read naturally even when we want
// to compare against raw tail-line text without the [stdout]/[stderr]
// prefix the streaming messages carry.
function stripPrefixForTail(s: string): string {
  return s.replace(/^\[stdout\] |^\[stderr\] /, '');
}

// ─── Output flood regression ────────────────────────────────────────
//
// A single verbose CI step (Cypress E2E, tsc/webpack ANSI spam, DB migration
// chatter) once wrote one `messages` row + one `message` WebSocket broadcast
// per output line. A real run produced >1M rows, bloating SQLite to multi-GB,
// exploding the WAL, freezing the event loop, and flooding the live session
// window. Output now goes to the log store as a SINGLE blob per step — never
// the message stream — so a million-line step writes zero output messages.
describe('runJobSteps — output never floods the message stream', () => {
  it('writes the step output ONCE to the log store, with no per-line messages', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const { store: logStore, writes: logWrites } = makeLogStore();
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      logStore,
      now: makeMonoClock(),
    };
    const config = makeConfig([{ name: 'E2E', run: 'npm run e2e' }]);

    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });

    await microtaskTick();
    const N = 5000;
    let buf = '';
    for (let i = 0; i < N; i++) buf += `noise line ${i}\n`;
    fakes[0].stdout.push(buf);
    await microtaskTick();
    fakes[0].emitter.emit('close', 0);

    const result = await resultP;
    expect(result.status).toBe('success');
    // Every line is still counted (full triage context preserved)…
    expect(result.stepResults[0].stdoutLines).toBe(N);
    // …the store receives exactly one blob carrying the full line count…
    expect(logStore.write).toHaveBeenCalledTimes(1);
    expect(logWrites[0].snapshot.totalLines).toBe(N);
    // …and NO output is streamed into the session: the only message is the
    // single checks-round summary, and no `message` broadcast per line.
    expect(stmts.addMessage.run.mock.calls.length).toBeLessThanOrEqual(1);
    const messageBroadcasts = broadcast.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type?: string }).type === 'message',
    );
    expect(messageBroadcasts.length).toBeLessThanOrEqual(1);
  });
});

// ─── Terminal state must not block on the log upload (regression) ────
//
// The store write is best-effort. If announceStepEnd is awaited BEHIND the
// upload (the original bug), a slow/hung S3 or local backend keeps the step
// row in `running` after the child has already exited — distorting the UI,
// cancellation, and active-time accounting. The terminal state must be
// persisted + broadcast FIRST; the log location is attached afterward.
describe('runJobSteps — terminal step state precedes the log upload', () => {
  it('returns success while the upload is pending, then attaches the log in the background', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };

    // A write that stays pending until we explicitly resolve it — simulating a
    // slow backend.
    let resolveWrite!: (v: StepLogPersist) => void;
    const writeP = new Promise<StepLogPersist>((r) => {
      resolveWrite = r;
    });
    const logStore: FinalizeStepLogStore = {
      write: vi.fn(() => writeP),
      read: vi.fn(async () => null),
    };

    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      logStore,
      now: makeMonoClock(),
    };
    const config = makeConfig([{ name: 'Build', run: 'npm run build' }]);
    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });

    await microtaskTick();
    fakes[0].stdout.push('compiling\n');
    await microtaskTick();
    fakes[0].emitter.emit('close', 0);

    // The phase returns success WHILE the upload is still pending — finalize
    // completion is never blocked by blob-storage latency.
    const result = await resultP;
    expect(result.status).toBe('success');
    expect(logStore.write).toHaveBeenCalledTimes(1);
    // The step was broadcast passed…
    const passedState = broadcast.mock.calls.find(
      (c: unknown[]) =>
        (c[0] as { type?: string; state?: string }).type === 'finalize_run_step_state' &&
        (c[0] as { state?: string }).state === 'passed',
    );
    expect(passedState).toBeTruthy();
    // …but the log location has NOT been attached yet (write still pending).
    expect(stmts.attachFinalizeRunStepLog.run).not.toHaveBeenCalled();

    // The detached upload finishes later and attaches the location in the
    // background, after the run has already completed.
    resolveWrite({
      storage_kind: 'local',
      storage_bucket: null,
      storage_region: null,
      key: `finalize-logs/${RUN_ID}/1.json.gz`,
      lines: 1,
      truncated: false,
    });
    await microtaskTick();
    expect(stmts.attachFinalizeRunStepLog.run).toHaveBeenCalledTimes(1);
    const attachArgs = stmts.attachFinalizeRunStepLog.run.mock.calls[0];
    expect(attachArgs[3]).toBe(`finalize-logs/${RUN_ID}/1.json.gz`); // log_key
    expect(attachArgs[6]).toBe(RUN_ID); // run_id
    expect(attachArgs[7]).toBe(1); // step_index
  });

  it('starts the next step without waiting for the prior step upload', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };

    // Every upload stays pending until we drain the resolvers, simulating a
    // hung backend across the whole run.
    const writeResolvers: Array<() => void> = [];
    const logStore: FinalizeStepLogStore = {
      write: vi.fn(
        (runId: string, stepIndex: number) =>
          new Promise<StepLogPersist>((res) => {
            writeResolvers.push(() =>
              res({
                storage_kind: 'local',
                storage_bucket: null,
                storage_region: null,
                key: `finalize-logs/${runId}/${stepIndex}.json.gz`,
                lines: 1,
                truncated: false,
              }),
            );
          }),
      ),
      read: vi.fn(async () => null),
    };

    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      logStore,
      now: makeMonoClock(),
    };
    const config = makeConfig([
      { name: 'Install', run: 'npm ci' },
      { name: 'Test', run: 'npm test' },
    ]);
    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });

    // Drive step 1 to completion — its upload is now pending (hung backend).
    await microtaskTick();
    fakes[0].stdout.push('installing\n');
    await microtaskTick();
    fakes[0].emitter.emit('close', 0);
    await microtaskTick();

    // Step 2 has ALREADY been spawned + broadcast running, even though step 1's
    // upload is still in flight — storage latency is off the critical path.
    expect(fakes).toHaveLength(2);
    expect(logStore.write).toHaveBeenCalledTimes(1);
    const step2Running = broadcast.mock.calls.find(
      (c: unknown[]) =>
        (c[0] as { type?: string; step_index?: number; state?: string }).type ===
          'finalize_run_step_state' &&
        (c[0] as { step_index?: number }).step_index === 2 &&
        (c[0] as { state?: string }).state === 'running',
    );
    expect(step2Running).toBeTruthy();

    // Finish step 2. The phase returns success even though BOTH uploads are
    // still pending — completion is never blocked by the detached uploads.
    fakes[1].stdout.push('testing\n');
    await microtaskTick();
    fakes[1].emitter.emit('close', 0);
    const result = await resultP;
    expect(result.status).toBe('success');
    expect(logStore.write).toHaveBeenCalledTimes(2);
    expect(stmts.attachFinalizeRunStepLog.run).not.toHaveBeenCalled();

    // The detached uploads attach their locations in the background afterward.
    writeResolvers.forEach((r) => r());
    await microtaskTick();
    expect(stmts.attachFinalizeRunStepLog.run).toHaveBeenCalledTimes(2);
  });

  it('returns a step failure without waiting for its log upload', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };

    // A never-resolving upload: if the failure path awaited it, the run would
    // hang and this test would time out.
    const logStore: FinalizeStepLogStore = {
      write: vi.fn(() => new Promise<StepLogPersist>(() => {})),
      read: vi.fn(async () => null),
    };

    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      logStore,
      now: makeMonoClock(),
    };
    const config = makeConfig([{ name: 'Test', run: 'npm test' }]);
    const resultP = runJobSteps(deps, {
      runId: RUN_ID,
      config,
      worktreePath: WORKTREE,
      sessionId: SESSION_ID,
    });

    await microtaskTick();
    fakes[0].stderr.push('boom\n');
    await microtaskTick();
    fakes[0].emitter.emit('close', 1);

    // Resolves promptly despite the upload never settling — fix dispatch /
    // finalize recovery is never blocked by the log upload.
    const result = await resultP;
    expect(result.status).toBe('failure');
    expect(result.failedStep?.index).toBe(1);
    expect(logStore.write).toHaveBeenCalledTimes(1);
  });
});

describe('withTimeout', () => {
  it('resolves when the promise settles before the deadline', async () => {
    await expect(__test.withTimeout(Promise.resolve('ok'), 1_000)).resolves.toBe('ok');
  });

  it('rejects when the promise outlives the deadline', async () => {
    const never = new Promise<string>(() => {});
    await expect(__test.withTimeout(never, 5)).rejects.toThrow(/timed out/);
  });
});

describe('runStepsSequence — deferRunTerminal (v2 matrix shard contract)', () => {
  // The seam behind the "test fails → run looks finished / session waits for
  // user input while siblings keep running" bug (#1122). A matrix shard runs
  // through this shared sequence; it must NOT write the run-level terminal on
  // failure (its siblings are still in flight). The v1 single-sequence path
  // keeps owning its terminal write — so the flag must be opt-in.
  function makeFailingDeps() {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const spawnStep: SpawnStepFn = () => {
      const f = makeFakeChild();
      fakes.push(f);
      return f.child;
    };
    const deps: StepRunnerDeps = {
      stmts: stmts as never,
      broadcast,
      spawnStep,
      now: makeMonoClock(),
    };
    return { stmts, deps, fakes };
  }

  async function driveSingleFailingStep(fakes: ReturnType<typeof makeFakeChild>[]) {
    await microtaskTick();
    fakes[0].stderr.push('AssertionError: boom\n');
    await microtaskTick();
    fakes[0].emitter.emit('close', 1);
  }

  it('does NOT call failFinalizeRun when deferRunTerminal is true (shard defers to orchestrator)', async () => {
    const { stmts, deps, fakes } = makeFailingDeps();
    const resultP = runStepsSequence(deps, {
      runId: RUN_ID,
      sessionId: SESSION_ID,
      worktreePath: WORKTREE,
      steps: [{ name: 'Test', run: 'npm test' }],
      timeoutMinutes: 60,
      skipPhaseInit: true,
      deferRunTerminal: true,
    });
    await driveSingleFailingStep(fakes);
    const result = await resultP;

    // The failure is still surfaced to the caller (orchestrator/job-runner)…
    expect(result.status).toBe('failure');
    expect(result.failedStep).toMatchObject({ name: 'Test', exitCode: 1 });
    // …but the run-level terminal was NOT written by the shard.
    expect(stmts.failFinalizeRun.run).not.toHaveBeenCalled();
  });

  it('still calls failFinalizeRun when deferRunTerminal is omitted (v1 path unchanged)', async () => {
    const { stmts, deps, fakes } = makeFailingDeps();
    const resultP = runStepsSequence(deps, {
      runId: RUN_ID,
      sessionId: SESSION_ID,
      worktreePath: WORKTREE,
      steps: [{ name: 'Test', run: 'npm test' }],
      timeoutMinutes: 60,
      skipPhaseInit: true,
    });
    await driveSingleFailingStep(fakes);
    const result = await resultP;

    expect(result.status).toBe('failure');
    expect(stmts.failFinalizeRun.run).toHaveBeenCalledWith('failed', 'step_failed', RUN_ID);
  });
});
