/**
 * step-runner.ts — Finalize Code Changes, Phase 4 (tasks phase).
 *
 * Numbering follows the design doc (`finalize-code-changes-architecture-v0`):
 *
 *   1. rebase   → `server/finalize/rebase.ts`           (landed)
 *   2. parse    → `server/finalize/ci-config.ts`        (landed)
 *   3. review   → `server/finalize/reviewer-dispatch.ts` (landed)
 *   4. tasks    → THIS FILE
 *   5. push     → `server/finalize/push-gate.ts` (future card)
 *
 * Responsibilities (per design §3, §5, §7, §13):
 *
 *   - Consume a parsed {@link CiConfig} from the parse phase.
 *   - Run each declared step sequentially in the session's worktree.
 *     The session's worktree IS the isolation boundary — the Agent Hub
 *     container that runs this code is the only sandbox primitive at v0
 *     (per design §6 "no dedicated Hub CI agent"). No new sandbox is
 *     created here.
 *   - Execute each step as a single `bash -euo pipefail -c <run>`
 *     invocation. The shell prefix is locked at parse time
 *     ({@link FINALIZE_STEP_SHELL}); there is no `shell:` override at v1.
 *   - Stream stdout AND stderr to the session message log line-by-line
 *     using the existing `addMessage` infra (role = 'system'). Each line
 *     gets its own message row so the chat UI scrolls naturally and the
 *     transcript stays grep-friendly. Broadcasts `message` events so live
 *     subscribers see output without reloading.
 *   - Capture every step's exit code. A non-zero exit short-circuits the
 *     remaining steps — there is no `continue-on-error:` directive at v0,
 *     matching ci.yaml v1's hard-fail-on-first-failure contract.
 *   - Apply the per-run `timeout_minutes` (from {@link CiConfig}) as the
 *     ceiling for the whole step phase. Individual step timeouts are not
 *     a v1 feature; the budget is shared across every step.
 *   - Return a result the orchestrator can map directly to the design's
 *     §10 failure-classification table (`step_failed` / `timeout`).
 *
 * Output streaming model:
 *
 *   Each chunk emitted by the child's `stdout` / `stderr` is split on
 *   newlines. Complete lines are persisted/broadcast immediately so the
 *   live log mirrors what `tail -f` would show. A trailing fragment with
 *   no newline is held in a per-stream buffer until either more data
 *   arrives or the process exits — on exit, any remaining buffered
 *   fragment is flushed as a final line. This matters because some
 *   commands (e.g. progress bars, anything writing without a terminating
 *   `\n`) would otherwise drop their last partial line on the floor.
 *
 *   Lines are tagged with the source stream (`stdout` / `stderr`) in the
 *   message `metadata` JSON so the UI can render stderr distinctly
 *   (red / italic / whatever). The body itself is the raw line text,
 *   prefixed with a tiny `[stdout]` / `[stderr]` marker so transcripts
 *   read sensibly in tools that don't render metadata.
 *
 * Result object (mirrors acceptance criteria):
 *
 *   {
 *     status: 'success' | 'failure' | 'timeout' | 'infra_error',
 *     failedStep?: {
 *       index: number,         // 1-indexed, matching CiStep.name default
 *       name: string,          // CiStep.name (defaulted at parse time)
 *       run: string,           // verbatim CiStep.run
 *       exitCode: number,      // -1 sentinel when the process died without one
 *       outputTail: string[],  // last N lines, suitable for §7 dispatch body
 *     },
 *     stepResults: StepResult[], // one entry per step that actually ran
 *     activeSecondsBilled: number,
 *   }
 *
 * The orchestrator uses `failedStep` to populate the §7 fix-dispatch
 * message body and the `finalize_runs.failed_step_*` columns.
 */

import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import type { ChildProcess } from 'child_process';
import type {
  BroadcastFn,
  FinalizeRunPhase,
  FinalizeRunStatus,
  MessageRow,
  Stmts,
} from '../types.js';
import { FINALIZE_STEP_SHELL } from './ci-config.js';
import type { CiConfig, CiStep } from './ci-config.js';

/**
 * Argv form of {@link FINALIZE_STEP_SHELL}. Parsed once at module load so
 * `defaultSpawnStep` can hand the bin + flags straight to {@link spawn}
 * without re-splitting on every step. Splitting at load time keeps the
 * parser and the executor locked to the same shell string — if ci-config
 * ever changes the prefix (it shouldn't, but the constant exists exactly
 * so the change can happen in one place), this picks up the new value
 * for free instead of silently drifting.
 *
 * Layout: `['bash', '-euo', 'pipefail', '-c']` for the canonical
 * `bash -euo pipefail -c <run>`. We then append `step.run` as the final
 * argv element so it stays a single shell string (no word-splitting of
 * the user's script — `bash -c` semantics).
 */
const STEP_SHELL_ARGV = FINALIZE_STEP_SHELL.split(/\s+/u);
const STEP_SHELL_BIN = STEP_SHELL_ARGV[0];
const STEP_SHELL_FLAGS = STEP_SHELL_ARGV.slice(1);

/**
 * Wall-clock cap per step spawn. Defensive: ci.yaml's `timeout_minutes`
 * applies to the whole pipeline, not individual steps, but we still want
 * a per-process ceiling so a hung step can never block the budget timer
 * from firing. Set deliberately high (the whole-pipeline cap is 60min);
 * this only catches "child stopped responding entirely" cases.
 */
export const STEP_SPAWN_HARD_TIMEOUT_MS = 60 * 60 * 1_000;

/**
 * How many trailing lines of mixed stdout/stderr we keep for the §7
 * fix-dispatch body. Mirrors the "Last output (40 lines)" wording in the
 * design doc. Lines beyond the tail still land in the session log via
 * the streaming inserts — the tail is purely for the structured handoff.
 */
export const STEP_OUTPUT_TAIL_LINES = 40;

/**
 * Maximum number of bytes we keep in the trailing-line buffer for a
 * single step. Guards against a step that emits gigabytes of output
 * without a newline — at some point we flush the partial buffer rather
 * than holding it indefinitely. Generous on purpose; most real CLIs
 * never trip this.
 */
export const STEP_PARTIAL_LINE_FLUSH_BYTES = 64 * 1024;

/** Active-time billed per step that actually ran (success or failure). */
export const STEP_ACTIVE_SECONDS_PER_STEP = 5;

/** Active-time billed on top of step time when the phase enters. */
export const TASKS_PHASE_ENTRY_ACTIVE_SECONDS = 1;

/**
 * Per-step result. One entry per step that the runner actually invoked.
 * Steps that were short-circuited after a failure do not appear here —
 * the orchestrator surfaces "remaining steps not executed" purely from
 * the `failedStep.index` vs `config.steps.length` gap.
 */
export interface StepResult {
  /** 1-indexed position in `config.steps`. */
  index: number;
  /** Step display name (parse-time default applied). */
  name: string;
  /** Verbatim `run` string from ci.yaml. */
  run: string;
  /** Exit code reported by the child. `-1` on spawn / runtime errors. */
  exitCode: number;
  /** Whole-step duration in milliseconds. */
  durationMs: number;
  /** Number of stdout lines streamed (after splitting). */
  stdoutLines: number;
  /** Number of stderr lines streamed (after splitting). */
  stderrLines: number;
}

/** Tagged failure surface — mirrors §10 of the design doc. */
export type StepRunStatus = 'success' | 'failure' | 'timeout' | 'infra_error';

export interface StepRunResult {
  status: StepRunStatus;
  /**
   * Populated when {@link status} is `'failure'` or `'timeout'`. Carries
   * everything the §7 dispatch body needs.
   */
  failedStep?: {
    index: number;
    name: string;
    run: string;
    exitCode: number;
    outputTail: string[];
  };
  /** Every step actually invoked, in declaration order. */
  stepResults: StepResult[];
  /** Total active seconds the phase billed to `finalize_runs`. */
  activeSecondsBilled: number;
  /**
   * Set on `infra_error`. Free-text diagnostic — kept off the success
   * path because the orchestrator only surfaces it on the failure
   * branch.
   */
  infraErrorDetail?: string;
}

/**
 * Minimal child-process shape the runner needs. Production wires this to
 * {@link spawn} (the default {@link defaultSpawnStep}); tests inject a
 * fake that emits scripted `stdout` / `stderr` chunks and a `close`
 * event so the streaming logic exercises end-to-end without going near
 * a real shell.
 */
export interface SpawnedStep {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SpawnStepArgs {
  step: CiStep;
  index: number;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export type SpawnStepFn = (args: SpawnStepArgs) => SpawnedStep;

export interface StepRunnerDeps {
  stmts: Pick<
    Stmts,
    | 'updateFinalizeRunPhase'
    | 'updateFinalizeRunActiveSeconds'
    | 'failFinalizeRun'
    | 'addMessage'
    | 'touchSession'
    | 'getMessageById'
  >;
  broadcast: BroadcastFn;
  /**
   * Override the child-process spawn. Tests inject a fake; production
   * uses {@link defaultSpawnStep}.
   */
  spawnStep?: SpawnStepFn;
  /**
   * Inject a clock so timeout / duration tests are deterministic.
   * Defaults to {@link Date.now}.
   */
  now?: () => number;
  /**
   * Override the per-spawn hard timeout. Tests use a few hundred
   * milliseconds; production keeps {@link STEP_SPAWN_HARD_TIMEOUT_MS}.
   */
  spawnHardTimeoutMs?: number;
}

export interface StepRunnerOptions {
  /** finalize_runs.id. */
  runId: string;
  /** Parsed ci.yaml. Steps are run in declaration order. */
  config: CiConfig;
  /** Absolute path of the session's worktree (working directory). */
  worktreePath: string;
  /** Session to stream output into. Must be non-null at this phase. */
  sessionId: string;
  /** Extra env injected per-step (PATH augmentations, tokens, etc.). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Run the tasks phase end-to-end.
 *
 * Pre-conditions (caller's responsibility):
 *   - `finalize_runs` row exists and the rebase + review phases have
 *     already finished.
 *   - `config` is the validated {@link CiConfig} from the parse phase
 *     (post-{@link parseCiConfig}).
 *   - `worktreePath` is on the correct head SHA. The runner does not
 *     re-check the git state — that's the rebase phase's job.
 *
 * Post-conditions:
 *   - `finalize_runs.phase = 'tasks'`, `status = 'running'` while steps
 *     are in flight.
 *   - On success → status stays `running`; the orchestrator advances to
 *     the push phase.
 *   - On non-success → `failFinalizeRun` is called with the appropriate
 *     terminal status + `failure_reason`. The orchestrator is expected
 *     to read the result and dispatch the §7 fix message into the
 *     session before moving the row to its final state.
 *
 * The streaming-output insertion path is best-effort: if `addMessage` or
 * the broadcast throws for one line, we log and keep going. We do NOT
 * abort a step because the chat UI hiccupped.
 */
export async function runStepPhase(
  deps: StepRunnerDeps,
  opts: StepRunnerOptions,
): Promise<StepRunResult> {
  const { stmts, broadcast } = deps;
  const spawnStep = deps.spawnStep ?? defaultSpawnStep;
  const now = deps.now ?? Date.now;
  const spawnHardTimeoutMs = deps.spawnHardTimeoutMs ?? STEP_SPAWN_HARD_TIMEOUT_MS;

  if (!opts.worktreePath) {
    return terminate(
      stmts,
      opts.runId,
      'infra_error',
      'worktree_create_failed',
      'worktree path missing for tasks phase',
      0,
      [],
      'worktree path missing',
    );
  }
  if (!opts.sessionId) {
    // The streaming insert path keys off sessionId; without it we cannot
    // surface output to the user — refuse to start rather than running
    // blind.
    return terminate(
      stmts,
      opts.runId,
      'infra_error',
      'container_unavailable',
      'session id missing for tasks phase',
      0,
      [],
      'session id missing',
    );
  }

  setPhase(stmts, broadcast, opts.runId, 'tasks', 'running');
  // Charge a small entry cost so the active-seconds counter advances
  // even for a pipeline with zero steps that pass instantly. Mirrors
  // how the rebase phase bills a fixed unit per attempt.
  let activeSecondsBilled = TASKS_PHASE_ENTRY_ACTIVE_SECONDS;
  stmts.updateFinalizeRunActiveSeconds.run(TASKS_PHASE_ENTRY_ACTIVE_SECONDS, opts.runId);

  const budgetMs = opts.config.timeoutMinutes * 60_000;
  const startedAt = now();
  const stepResults: StepResult[] = [];

  for (let i = 0; i < opts.config.steps.length; i += 1) {
    const step = opts.config.steps[i];
    const stepIndex = i + 1;
    const remainingBudgetMs = budgetMs - (now() - startedAt);
    if (remainingBudgetMs <= 0) {
      // Budget exhausted before this step could start. We surface as
      // timeout with this step as the "failed" one so the dispatch body
      // points the user at the step that didn't even run.
      const tail = ['[timeout] pipeline budget exhausted before step started'];
      announceLine(deps, opts.sessionId, opts.runId, stepIndex, step, 'stderr', tail[0]);
      return terminate(
        stmts,
        opts.runId,
        'timeout',
        'timeout',
        `pipeline budget of ${opts.config.timeoutMinutes}min exhausted at step ${stepIndex}`,
        activeSecondsBilled,
        stepResults,
        undefined,
        {
          index: stepIndex,
          name: step.name,
          run: step.run,
          exitCode: -1,
          outputTail: tail,
        },
      );
    }

    const stepHardTimeoutMs = Math.min(remainingBudgetMs, spawnHardTimeoutMs);
    announceStepStart(deps, opts.sessionId, opts.runId, stepIndex, step);

    const runOutcome = await runSingleStep({
      step,
      stepIndex,
      cwd: opts.worktreePath,
      env: opts.env,
      sessionId: opts.sessionId,
      runId: opts.runId,
      deps,
      now,
      spawnStep,
      hardTimeoutMs: stepHardTimeoutMs,
    });

    activeSecondsBilled += STEP_ACTIVE_SECONDS_PER_STEP;
    stmts.updateFinalizeRunActiveSeconds.run(STEP_ACTIVE_SECONDS_PER_STEP, opts.runId);

    stepResults.push(runOutcome.result);

    if (runOutcome.kind === 'success') {
      announceStepEnd(deps, opts.sessionId, opts.runId, stepIndex, step, 0);
      continue;
    }

    // Failure — short-circuit. Surface the failed step in the dispatch
    // payload and persist the terminal status.
    announceStepEnd(deps, opts.sessionId, opts.runId, stepIndex, step, runOutcome.result.exitCode);

    if (runOutcome.kind === 'timeout') {
      return terminate(
        stmts,
        opts.runId,
        'timeout',
        'timeout',
        `step ${stepIndex} (${step.name}) exceeded the pipeline budget`,
        activeSecondsBilled,
        stepResults,
        undefined,
        {
          index: stepIndex,
          name: step.name,
          run: step.run,
          exitCode: runOutcome.result.exitCode,
          outputTail: runOutcome.outputTail,
        },
      );
    }

    if (runOutcome.kind === 'spawn-error') {
      return terminate(
        stmts,
        opts.runId,
        'infra_error',
        'container_unavailable',
        `step ${stepIndex} (${step.name}) failed to spawn: ${runOutcome.detail}`,
        activeSecondsBilled,
        stepResults,
        runOutcome.detail,
        {
          index: stepIndex,
          name: step.name,
          run: step.run,
          exitCode: runOutcome.result.exitCode,
          outputTail: runOutcome.outputTail,
        },
      );
    }

    // Plain non-zero exit.
    return terminate(
      stmts,
      opts.runId,
      'failure',
      'step_failed',
      `step ${stepIndex} (${step.name}) failed with exit ${runOutcome.result.exitCode}`,
      activeSecondsBilled,
      stepResults,
      undefined,
      {
        index: stepIndex,
        name: step.name,
        run: step.run,
        exitCode: runOutcome.result.exitCode,
        outputTail: runOutcome.outputTail,
      },
    );
  }

  // All steps green. Status remains `running`; the orchestrator advances
  // to push. We do NOT mark the row terminal here — Finalize is only
  // "done" after a successful push or a hard failure later.
  return {
    status: 'success',
    stepResults,
    activeSecondsBilled,
  };
}

// ─── internals ──────────────────────────────────────────────────────

type SingleStepOutcome =
  | { kind: 'success'; result: StepResult; outputTail: string[] }
  | { kind: 'non-zero-exit'; result: StepResult; outputTail: string[] }
  | { kind: 'timeout'; result: StepResult; outputTail: string[] }
  | { kind: 'spawn-error'; result: StepResult; outputTail: string[]; detail: string };

interface RunSingleStepArgs {
  step: CiStep;
  stepIndex: number;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  sessionId: string;
  runId: string;
  deps: StepRunnerDeps;
  now: () => number;
  spawnStep: SpawnStepFn;
  hardTimeoutMs: number;
}

/**
 * Run one step with line-buffered streaming. Resolves when the child
 * closes (or a hard timeout fires). Never rejects — every failure mode
 * becomes a tagged {@link SingleStepOutcome}.
 */
function runSingleStep(args: RunSingleStepArgs): Promise<SingleStepOutcome> {
  const { step, stepIndex, sessionId, runId, deps, now, spawnStep, hardTimeoutMs } = args;

  return new Promise<SingleStepOutcome>((resolve) => {
    const startedAt = now();
    const tail = new BoundedLineTail(STEP_OUTPUT_TAIL_LINES);
    let stdoutLines = 0;
    let stderrLines = 0;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;
    let timedOut = false;

    let child: SpawnedStep;
    try {
      child = spawnStep({ step, index: stepIndex, cwd: args.cwd, env: args.env });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const line = `[spawn-error] ${detail}`;
      tail.push(line);
      announceLine(deps, sessionId, runId, stepIndex, step, 'stderr', line);
      resolve({
        kind: 'spawn-error',
        detail,
        result: {
          index: stepIndex,
          name: step.name,
          run: step.run,
          exitCode: -1,
          durationMs: now() - startedAt,
          stdoutLines,
          stderrLines: stderrLines + 1,
        },
        outputTail: tail.snapshot(),
      });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
      // A second-phase SIGKILL after a short grace period so a child
      // that swallows SIGTERM doesn't hold the promise open. Guarded by
      // `settled` to mirror the outer timer's pattern: a child that
      // exits cleanly on SIGTERM within the grace window must not get a
      // stray SIGKILL aimed at a dead (or recycled) PID. The `try/catch`
      // below would swallow the kernel ESRCH anyway, but skipping the
      // syscall entirely is cleaner and surfaces in strace.
      setTimeout(() => {
        if (settled) return;
        try {
          child.kill('SIGKILL');
        } catch {
          /* best-effort */
        }
      }, 1_000).unref?.();
    }, hardTimeoutMs);
    timer.unref?.();

    const consume = (chunk: Buffer | string, stream: 'stdout' | 'stderr'): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const buffered = stream === 'stdout' ? stdoutBuffer + text : stderrBuffer + text;
      const lines = buffered.split('\n');
      // Last element is the partial fragment (may be empty if data ended on \n).
      const trailing = lines.pop() ?? '';
      for (const raw of lines) {
        const line = stripCarriageReturn(raw);
        tail.push(line);
        if (stream === 'stdout') stdoutLines += 1;
        else stderrLines += 1;
        announceLine(deps, sessionId, runId, stepIndex, step, stream, line);
      }
      // Flush the partial buffer if it has grown too large — protects
      // against a step that streams forever without a newline.
      if (trailing.length >= STEP_PARTIAL_LINE_FLUSH_BYTES) {
        const line = stripCarriageReturn(trailing);
        tail.push(line);
        if (stream === 'stdout') stdoutLines += 1;
        else stderrLines += 1;
        announceLine(deps, sessionId, runId, stepIndex, step, stream, line);
        if (stream === 'stdout') stdoutBuffer = '';
        else stderrBuffer = '';
      } else if (stream === 'stdout') {
        stdoutBuffer = trailing;
      } else {
        stderrBuffer = trailing;
      }
    };

    child.stdout?.on('data', (chunk: Buffer | string) => consume(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer | string) => consume(chunk, 'stderr'));

    const flushTrailingFragments = (): void => {
      if (stdoutBuffer.length > 0) {
        const line = stripCarriageReturn(stdoutBuffer);
        tail.push(line);
        stdoutLines += 1;
        announceLine(deps, sessionId, runId, stepIndex, step, 'stdout', line);
        stdoutBuffer = '';
      }
      if (stderrBuffer.length > 0) {
        const line = stripCarriageReturn(stderrBuffer);
        tail.push(line);
        stderrLines += 1;
        announceLine(deps, sessionId, runId, stepIndex, step, 'stderr', line);
        stderrBuffer = '';
      }
    };

    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const detail = err.message || String(err);
      const line = `[spawn-error] ${detail}`;
      tail.push(line);
      stderrLines += 1;
      announceLine(deps, sessionId, runId, stepIndex, step, 'stderr', line);
      flushTrailingFragments();
      resolve({
        kind: 'spawn-error',
        detail,
        result: {
          index: stepIndex,
          name: step.name,
          run: step.run,
          exitCode: -1,
          durationMs: now() - startedAt,
          stdoutLines,
          stderrLines,
        },
        outputTail: tail.snapshot(),
      });
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      flushTrailingFragments();
      const exitCode = code ?? -1;
      const durationMs = now() - startedAt;
      const result: StepResult = {
        index: stepIndex,
        name: step.name,
        run: step.run,
        exitCode,
        durationMs,
        stdoutLines,
        stderrLines,
      };
      if (timedOut) {
        resolve({ kind: 'timeout', result, outputTail: tail.snapshot() });
        return;
      }
      if (exitCode === 0) {
        resolve({ kind: 'success', result, outputTail: tail.snapshot() });
        return;
      }
      resolve({ kind: 'non-zero-exit', result, outputTail: tail.snapshot() });
    });
  });
}

/**
 * Persist + broadcast a single output line. Best-effort — a DB or socket
 * failure logs and continues so a hiccup in chat infra can't kill a
 * step.
 */
function announceLine(
  deps: StepRunnerDeps,
  sessionId: string,
  runId: string,
  stepIndex: number,
  step: CiStep,
  stream: 'stdout' | 'stderr',
  text: string,
): void {
  const { stmts, broadcast } = deps;
  const prefix = stream === 'stdout' ? '[stdout]' : '[stderr]';
  const body = `${prefix} ${text}`;
  const metadata = JSON.stringify({
    kind: 'finalize_step_output',
    runId,
    stepIndex,
    stepName: step.name,
    stream,
  });
  const msgId = uuidv4();
  try {
    stmts.addMessage.run(
      msgId,
      sessionId,
      'system',
      body,
      null,
      null,
      null,
      metadata,
      null,
      null,
      null,
    );
  } catch (err) {
    console.warn(
      `[finalize-step-runner] addMessage failed for session=${sessionId} step=${stepIndex}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  try {
    stmts.touchSession.run(sessionId);
  } catch {
    /* best-effort */
  }
  try {
    const inserted = stmts.getMessageById.get(msgId) as MessageRow | undefined;
    if (inserted) {
      broadcast({ type: 'message', sessionId, message: inserted });
    }
  } catch (err) {
    console.warn(
      `[finalize-step-runner] message broadcast failed for session=${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Announce step boundaries (start / end) on the live event bus. These do
 * NOT land in the session message log — they're transient progress
 * signals for the checks panel UI. The output lines themselves are the
 * canonical record of "what this step said".
 */
function announceStepStart(
  deps: StepRunnerDeps,
  sessionId: string,
  runId: string,
  stepIndex: number,
  step: CiStep,
): void {
  try {
    deps.broadcast({
      type: 'finalize_run_step_state',
      run_id: runId,
      session_id: sessionId,
      step_index: stepIndex,
      step_name: step.name,
      state: 'running',
    });
  } catch (err) {
    console.warn(
      `[finalize-step-runner] step-start broadcast failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function announceStepEnd(
  deps: StepRunnerDeps,
  sessionId: string,
  runId: string,
  stepIndex: number,
  step: CiStep,
  exitCode: number,
): void {
  try {
    deps.broadcast({
      type: 'finalize_run_step_state',
      run_id: runId,
      session_id: sessionId,
      step_index: stepIndex,
      step_name: step.name,
      state: exitCode === 0 ? 'passed' : 'failed',
      exit_code: exitCode,
    });
  } catch (err) {
    console.warn(
      `[finalize-step-runner] step-end broadcast failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function setPhase(
  stmts: StepRunnerDeps['stmts'],
  broadcast: BroadcastFn,
  runId: string,
  phase: FinalizeRunPhase,
  status: FinalizeRunStatus,
): void {
  stmts.updateFinalizeRunPhase.run(phase, status, runId);
  broadcast({
    type: 'finalize_run_phase_changed',
    run_id: runId,
    phase,
    status,
  });
}

/**
 * Persist a terminal status on `finalize_runs` and build the failure-shaped
 * {@link StepRunResult} the orchestrator consumes.
 *
 * Status mapping:
 *   - `'failure'` → DB row gets `status='failed'`, `failure_reason=<code>`.
 *   - `'timeout'` → DB row gets `status='timed_out'`, `failure_reason=<code>`.
 *   - `'infra_error'` → **NO DB write here.** The design (§10) reserves the
 *     infra class for an automatic one-shot retry. Writing a terminal status
 *     here would make the retry path unreachable — the orchestrator owns the
 *     decision to retry vs. fail terminal, so we surface the tagged result
 *     and leave the `finalize_runs.status` column at its current value
 *     (`running` from the phase-entry write). The UI shows `running` until
 *     the orchestrator either retries (new row with `retry_of_run_id` set)
 *     or accepts defeat and calls `failFinalizeRun` itself.
 *
 * `stepResults` is the accumulator of every step the runner actually
 * invoked, in declaration order — threaded through so a 3-step pipeline
 * that fails on step 2 still surfaces step 1's StepResult to the caller.
 * The orchestrator uses this for the §7 dispatch body's "passed: X /
 * failed at Y" summary and for the UI checks-panel state.
 */
function terminate(
  stmts: StepRunnerDeps['stmts'],
  runId: string,
  status: StepRunStatus,
  failureReason: string,
  _detail: string,
  activeSecondsBilled: number,
  stepResults: StepResult[],
  infraErrorDetail?: string,
  failedStep?: StepRunResult['failedStep'],
): StepRunResult {
  // `_detail` is intentionally unused inside this helper — the failure
  // detail surfaces via the per-line `addMessage` stream and the §7
  // fix-dispatch body the orchestrator builds from `failedStep`. We keep
  // it on the signature so future tooling (a structured failure log,
  // telemetry, etc.) has an obvious place to plug in without re-threading
  // every call-site.
  if (status === 'failure') {
    stmts.failFinalizeRun.run('failed', failureReason, runId);
  } else if (status === 'timeout') {
    stmts.failFinalizeRun.run('timed_out', failureReason, runId);
  }
  // No-op on `'infra_error'` — see doc comment above. The orchestrator
  // is responsible for either spawning the retry row or persisting
  // `failFinalizeRun('infra_error', ...)` once the retry budget is spent.
  return {
    status,
    stepResults,
    activeSecondsBilled,
    ...(failedStep ? { failedStep } : {}),
    ...(infraErrorDetail ? { infraErrorDetail } : {}),
  };
}

/** Strip a single trailing CR so CRLF-emitting children render cleanly. */
function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Production spawn — `bash -euo pipefail -c <run>` per design §5.
 *
 * The shell prefix comes from {@link FINALIZE_STEP_SHELL} (re-exported
 * by `ci-config.ts`) so the parser and the executor cannot drift. There
 * is no `shell:` override at v1, by design.
 */
export const defaultSpawnStep: SpawnStepFn = ({ step, cwd, env }) => {
  // bin + flags derived from `FINALIZE_STEP_SHELL` at module load. Appending
  // `step.run` as the trailing argv element preserves `bash -c` semantics —
  // the user's script is one argument, no word-splitting.
  const child: ChildProcess = spawn(STEP_SHELL_BIN, [...STEP_SHELL_FLAGS, step.run], {
    cwd,
    env: env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    on(event: 'close' | 'error', listener: (arg: never) => void) {
      child.on(event, listener as never);
      return child;
    },
    kill(signal?: NodeJS.Signals) {
      return child.kill(signal);
    },
  };
};

/**
 * Bounded ring of trailing lines. Push grows it; once it would exceed
 * {@link cap}, the oldest line is dropped. {@link snapshot} returns a
 * fresh copy so callers can persist / log without aliasing.
 */
class BoundedLineTail {
  private readonly buf: string[] = [];
  constructor(private readonly cap: number) {}
  push(line: string): void {
    this.buf.push(line);
    while (this.buf.length > this.cap) this.buf.shift();
  }
  snapshot(): string[] {
    return [...this.buf];
  }
}

export const __test = {
  BoundedLineTail,
  stripCarriageReturn,
  STEP_ACTIVE_SECONDS_PER_STEP,
  TASKS_PHASE_ENTRY_ACTIVE_SECONDS,
};
