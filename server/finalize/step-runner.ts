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
 *   - Capture stdout AND stderr and write each step's output ONCE to the
 *     finalize log store (S3 or local dir) as a single blob — NOT into the
 *     session message log. Per-line `messages` rows + `message` broadcasts
 *     used to flood the live session window and bloat SQLite (a verbose
 *     step could emit >1M rows). The step-log viewer lazy-loads the blob on
 *     click. Only the per-round checks SUMMARY (one message) reaches chat.
 *   - Capture every step's exit code. A non-zero exit short-circuits the
 *     remaining steps — there is no `continue-on-error:` directive at v0,
 *     matching ci.yaml v1's hard-fail-on-first-failure contract.
 *   - Apply the per-run `timeout_minutes` (from {@link CiConfig}) as the
 *     ceiling for the whole step phase. Individual step timeouts are not
 *     a v1 feature; the budget is shared across every step.
 *   - Return a result the orchestrator can map directly to the design's
 *     §10 failure-classification table (`step_failed` / `timeout`).
 *
 * Output capture model:
 *
 *   Each chunk emitted by the child's `stdout` / `stderr` is split on
 *   newlines. Complete lines feed (a) a bounded trailing tail + failure
 *   excerpt for the §7 fix-dispatch body and (b) a byte-capped
 *   {@link StepLogAccumulator} that becomes the stored blob. A trailing
 *   fragment with no newline is held in a per-stream buffer until either
 *   more data arrives or the process exits — on exit, any remaining
 *   buffered fragment is flushed as a final line. This matters because
 *   some commands (e.g. progress bars, anything writing without a
 *   terminating `\n`) would otherwise drop their last partial line.
 *
 *   Each stored line keeps its source stream (`stdout` / `stderr`) so the
 *   viewer can render stderr distinctly. The blob's location (backend kind
 *   + bucket/region + key) is stamped on the `finalize_run_steps` row so
 *   reads resolve the original backend even after the storage config
 *   changes. See `finalize-log-store.ts`.
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
import { randomUUID } from 'crypto';
import type { ChildProcess } from 'child_process';
import type {
  BroadcastFn,
  FinalizeRunPhase,
  FinalizeRunRow,
  FinalizeRunStatus,
  Stmts,
} from '../types.js';
import { FINALIZE_STEP_SHELL } from './ci-config.js';
import type { CiConfig, CiStep } from './ci-config.js';
import { listFinalizeRunSteps } from './step-output.js';
import {
  StepLogAccumulator,
  type FinalizeStepLogStore,
  type StepLogPersist,
  type StepLogSnapshot,
} from './finalize-log-store.js';
import {
  readFinalizeLoopRound,
  writeFinalizeChecksRoundTimeline,
  type TimelineMessageDeps,
} from './timeline-message.js';
import { detailIsSpotReclaim } from './spot-interruption.js';
import { hasTestFailureSummary, isRunnerTeardownExit } from './runner-teardown.js';
import { isRunnerCancellationCollateral } from './step-cancellation.js';

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
 * design doc. The full output is captured in the stored log blob — the
 * tail is purely for the structured handoff.
 */
export const STEP_OUTPUT_TAIL_LINES = 40;

/**
 * Failure-excerpt sizing. The plain tail above is a fixed trailing window,
 * which a chatty background service can fill with noise (e.g. a Postgres
 * sidecar emitting `checkpoint complete` lines every minute long after the
 * test runner has already printed its failure and exited). The excerpt
 * collector instead anchors on lines that *look like* a failure and keeps a
 * little context on each side, biased to the most recent failure region.
 *
 * `BEFORE` / `AFTER` are the context lines kept around each signal line;
 * `MAX_LINES` caps the whole excerpt (oldest dropped first) so a noisy run
 * with many matches still hands back a bounded, recent-failure-weighted slice.
 */
export const STEP_FAILURE_EXCERPT_CONTEXT_BEFORE = 8;
export const STEP_FAILURE_EXCERPT_CONTEXT_AFTER = 30;
export const STEP_FAILURE_EXCERPT_MAX_LINES = 160;

/**
 * Lines that mark a real test/build failure. Deliberately case-sensitive on
 * the capitalised forms (`Error`, `FAIL`, `FATAL`, `ERROR`) so a benign
 * lower-case "error" inside chatty info logs does not trip it, while still
 * catching the common framework markers:
 *   - mocha/cypress summary  → `1 failing`, `  1) test name`
 *   - jest/vitest/CI         → `FAIL`, `FAILED`
 *   - thrown errors          → `CypressError`, `TypeError`, `…Exception`
 *   - tsc                    → `error TS2304`
 *   - cypress actionability  → `not visible because`, `cannot be interacted`, `Timed out retrying`
 *   - postgres / generic     → `FATAL`, `ERROR`, `npm ERR!`, `✗ ✘ ✖ ✕`
 */
export const FAILURE_SIGNAL_RE = new RegExp(
  [
    '\\b\\d+ failing\\b',
    '\\bFAIL(?:ED)?\\b',
    '\\b\\w*(?:Error|Exception)\\b',
    '\\bTraceback\\b',
    'error TS\\d',
    '\\bERROR\\b',
    '\\bFATAL\\b',
    // Cypress-specific phrasing so unrelated lines ("Timed out waiting for
    // pod restart", "Config option is not visible in older clients") don't
    // register as failure signals. Cypress always emits "Timed out retrying
    // …" and "… is not visible because …".
    'Timed out retrying',
    'not visible because',
    'cannot be interacted',
    'npm ERR!',
    '[\\u2717\\u2718\\u2716\\u2715]',
    '^\\s*\\d+\\) ',
  ].join('|'),
);

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

/**
 * One failed step's full context — everything the §7 dispatch body needs to
 * describe a single red. Carried singly (`failedStep`) for the primary failure
 * and as an array (`failedSteps`) when several parallel jobs failed in the same
 * round.
 */
export interface FailedStepDetail {
  index: number;
  name: string;
  run: string;
  exitCode: number;
  outputTail: string[];
  /**
   * Signal-aware excerpt of the failing step's output — the lines that
   * matched a test/build failure marker ({@link FAILURE_SIGNAL_RE}) plus
   * surrounding context, biased to the most recent failure. Empty when no
   * marker was seen. This is what the §7 dispatch body leads with so a
   * chatty sidecar (e.g. a Postgres container's checkpoint logs) can't
   * bury the real failure under the plain trailing tail.
   */
  failureExcerpt?: string[];
  jobId?: string;
  matrixKey?: string;
}

export interface StepRunResult {
  status: StepRunStatus;
  /**
   * Populated when {@link status} is `'failure'` or `'timeout'`. Carries
   * everything the §7 dispatch body needs. This is the *primary* failure —
   * a genuine `failure`/`timeout` is preferred over `infra_error` collateral
   * when several shards went red (see {@link failedSteps}).
   */
  failedStep?: FailedStepDetail;
  /**
   * Every failed step across the round's parallel jobs/shards, not just the
   * primary one. The v2 job-runner waits for ALL jobs to finish before the
   * orchestrator dispatches a fix, so a single dispatch can — and should —
   * surface every failure at once (the agent fixes them together instead of
   * one-per-round). Ordered by job/step for a stable dispatch body. Absent on
   * the success path and on the v1 single-sequence path where there is at most
   * one failed step (use {@link failedStep} there).
   */
  failedSteps?: FailedStepDetail[];
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
  /**
   * The §10 machine `failure_reason` for a non-success terminal. The
   * orchestrator does NOT persist `infra_error` itself (it owns the retry
   * decision), so it reads this to choose the retry-generation cap: a
   * `spot_reclaimed` (the runner lost its instance to an EC2 Spot reclaim)
   * earns the generous reclaim cap, every other infra reason the conservative
   * one. Falls back to `container_unavailable` when absent. Carried for
   * `failure`/`timeout` too so callers have a single source of truth.
   */
  failureReason?: string;
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
    | 'getFinalizeRun'
    | 'updateFinalizeRunPhase'
    | 'updateFinalizeRunActiveSeconds'
    | 'failFinalizeRun'
    | 'upsertFinalizeRunStep'
    | 'beginFinalizeRunStepAttempt'
    | 'attachFinalizeRunStepLog'
    | 'listFinalizeRunStepsForRun'
    | 'upsertFinalizeRunJob'
    | 'listFinalizeRunJobsForRun'
    // Used only by the per-round checks-summary timeline message (a single
    // message per round) — NOT per output line. Per-line output goes to the
    // log store, not the message stream.
    | 'addMessage'
    | 'touchSession'
    | 'getMessageById'
  >;
  broadcast: BroadcastFn;
  /**
   * Store for per-step CI output blobs (S3 or local dir). When set, each
   * step's output is written here ONCE and the location is persisted on the
   * step row; nothing is streamed into the session message log. When omitted
   * (some tests), output is simply not persisted — the bounded tail / failure
   * excerpt still flow through the result for triage.
   */
  logStore?: FinalizeStepLogStore;
  /**
   * Override the child-process spawn. Tests inject a fake; production
   * uses {@link defaultSpawnStep}.
   */
  spawnStep?: SpawnStepFn;
  /**
   * Override the runner backend that stands up a runner per job instance
   * (DinD path). Tests inject a fake; production resolves via
   * {@link resolveRunnerBackend} (local DinD today, remote fleet later).
   */
  runnerBackend?: import('./runner-backend.js').RunnerBackend;
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

export interface StepPersistMeta {
  jobId?: string;
  matrixKey?: string;
}

export interface RunStepsSequenceOptions {
  runId: string;
  sessionId: string;
  worktreePath: string;
  steps: CiStep[];
  timeoutMinutes: number;
  env?: NodeJS.ProcessEnv;
  /** Prefix for display names (e.g. `e2e / Profiles & Tasks /`). */
  stepNamePrefix?: string;
  /** 1-indexed step indices; when omitted, uses 1..steps.length. */
  stepIndices?: number[];
  persistMeta?: StepPersistMeta;
  /** When true, skip setPhase + entry billing (caller owns phase setup). */
  skipPhaseInit?: boolean;
  /** When false, skip the checks-round timeline write (v2 job shards). Default true. */
  emitChecksTimeline?: boolean;
  /**
   * When true, this sequence is ONE shard of a larger run (the v2 matrix path)
   * and must NOT write the run-level terminal status on failure. A shard that
   * calls `failFinalizeRun('failed'|'timed_out', …)` stamps the whole
   * `finalize_runs` row terminal (status + `ended_at`) the moment the FIRST
   * shard fails — while sibling shards are still executing — which makes the
   * run look finished and flips the session to "waiting for user input" even
   * though tasks are still running. With this flag the shard only returns its
   * failure-shaped {@link StepRunResult}; the job-level state is persisted by
   * the job runner and the orchestrator owns the single run-level terminal
   * write once every shard has finished (mirrors how `infra_error` already
   * defers to the orchestrator). Default false (v1 single-sequence path owns
   * its terminal write, unchanged).
   */
  deferRunTerminal?: boolean;
}
export interface StepRunnerOptions {
  /** finalize_runs.id. */
  runId: string;
  /** Parsed ci.yaml v1. Steps are run in declaration order. */
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
  if (!opts.worktreePath) {
    return terminate(
      deps.stmts,
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
    return terminate(
      deps.stmts,
      opts.runId,
      'infra_error',
      'container_unavailable',
      'session id missing for tasks phase',
      0,
      [],
      'session id missing',
    );
  }

  return runStepsSequence(deps, {
    runId: opts.runId,
    sessionId: opts.sessionId,
    worktreePath: opts.worktreePath,
    steps: opts.config.steps,
    timeoutMinutes: opts.config.timeoutMinutes,
    env: opts.env,
  });
}

/**
 * Run an ordered list of steps (shared by v1 step phase and v2 job shards).
 */
export async function runStepsSequence(
  deps: StepRunnerDeps,
  opts: RunStepsSequenceOptions,
): Promise<StepRunResult> {
  const { stmts, broadcast } = deps;
  const spawnStep = deps.spawnStep ?? defaultSpawnStep;
  const now = deps.now ?? Date.now;
  const spawnHardTimeoutMs = deps.spawnHardTimeoutMs ?? STEP_SPAWN_HARD_TIMEOUT_MS;
  // v2 matrix shards defer the run-level terminal write to the orchestrator
  // (see RunStepsSequenceOptions.deferRunTerminal). A `false` here means a
  // failing shard never stamps `finalize_runs` terminal while siblings run.
  const writeRunTerminal = !opts.deferRunTerminal;

  if (!opts.skipPhaseInit) {
    setPhase(stmts, broadcast, opts.runId, opts.sessionId, 'tasks', 'running');
  }

  let activeSecondsBilled = opts.skipPhaseInit ? 0 : TASKS_PHASE_ENTRY_ACTIVE_SECONDS;
  if (!opts.skipPhaseInit) {
    stmts.updateFinalizeRunActiveSeconds.run(TASKS_PHASE_ENTRY_ACTIVE_SECONDS, opts.runId);
  }

  const budgetMs = opts.timeoutMinutes * 60_000;
  const startedAt = now();
  const stepResults: StepResult[] = [];
  const persistMeta = opts.persistMeta;

  for (let i = 0; i < opts.steps.length; i += 1) {
    const step = opts.steps[i];
    const stepIndex = opts.stepIndices?.[i] ?? i + 1;
    const displayName = opts.stepNamePrefix ? `${opts.stepNamePrefix}${step.name}` : step.name;
    persistFinalizeRunStep(
      stmts,
      opts.runId,
      stepIndex,
      displayName,
      'queued',
      null,
      null,
      null,
      persistMeta,
    );
  }

  for (let i = 0; i < opts.steps.length; i += 1) {
    const step = opts.steps[i];
    const stepIndex = opts.stepIndices?.[i] ?? i + 1;
    const displayName = opts.stepNamePrefix ? `${opts.stepNamePrefix}${step.name}` : step.name;
    const stepForRun = { ...step, name: displayName };
    const remainingBudgetMs = budgetMs - (now() - startedAt);
    if (remainingBudgetMs <= 0) {
      // Step never ran (budget exhausted before spawn) → no output to store.
      // The timeout detail still reaches the §7 fix dispatch via outputTail.
      const tail = ['[timeout] pipeline budget exhausted before step started'];
      return finishStepSequence(
        deps,
        opts,
        terminate(
          stmts,
          opts.runId,
          'timeout',
          'timeout',
          `pipeline budget of ${opts.timeoutMinutes}min exhausted at step ${stepIndex}`,
          activeSecondsBilled,
          stepResults,
          undefined,
          {
            index: stepIndex,
            name: displayName,
            run: step.run,
            exitCode: -1,
            outputTail: tail,
            ...(persistMeta?.jobId ? { jobId: persistMeta.jobId } : {}),
            ...(persistMeta?.matrixKey ? { matrixKey: persistMeta.matrixKey } : {}),
          },
          writeRunTerminal,
        ),
      );
    }

    const stepHardTimeoutMs = Math.min(remainingBudgetMs, spawnHardTimeoutMs);
    // announceStepStart mints this execution's log nonce and clears any prior
    // log location; thread it to the (detached) upload so its blob key + guarded
    // attach are tied to THIS execution.
    const attempt = announceStepStart(
      deps,
      opts.sessionId,
      opts.runId,
      stepIndex,
      stepForRun,
      persistMeta,
    );

    const runOutcome = await runSingleStep({
      step: stepForRun,
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

    // Persist the TERMINAL step state first so the UI/state machine flips the
    // step out of `running` the moment the child exits. The log upload is then
    // fired as fully-detached background work (`void` — never awaited anywhere)
    // so blob-storage latency is entirely off the critical path: the next step
    // starts, a failed step dispatches its fix context, AND the phase returns
    // success without ever waiting on the upload. uploadAndAttachStepLog never
    // rejects (it logs + swallows its own errors), so the detached promise is
    // safe to leave unhandled; the attach is an idempotent best-effort UPDATE
    // that lands a moment later in the long-lived Hub process.
    if (runOutcome.kind === 'success') {
      announceStepEnd(deps, opts.sessionId, opts.runId, stepIndex, stepForRun, 0, persistMeta);
      void uploadAndAttachStepLog(deps, opts.runId, stepIndex, runOutcome.logSnapshot, attempt);
      continue;
    }

    announceStepEnd(
      deps,
      opts.sessionId,
      opts.runId,
      stepIndex,
      stepForRun,
      runOutcome.result.exitCode,
      persistMeta,
    );
    void uploadAndAttachStepLog(deps, opts.runId, stepIndex, runOutcome.logSnapshot, attempt);

    const failedStep = {
      index: stepIndex,
      name: displayName,
      run: step.run,
      exitCode: runOutcome.result.exitCode,
      outputTail: runOutcome.outputTail,
      ...(runOutcome.failureExcerpt.length ? { failureExcerpt: runOutcome.failureExcerpt } : {}),
      ...(persistMeta?.jobId ? { jobId: persistMeta.jobId } : {}),
      ...(persistMeta?.matrixKey ? { matrixKey: persistMeta.matrixKey } : {}),
    };

    if (runOutcome.kind === 'timeout') {
      return finishStepSequence(
        deps,
        opts,
        terminate(
          stmts,
          opts.runId,
          'timeout',
          'timeout',
          `step ${stepIndex} (${displayName}) exceeded the pipeline budget`,
          activeSecondsBilled,
          stepResults,
          undefined,
          failedStep,
          writeRunTerminal,
        ),
      );
    }

    if (runOutcome.kind === 'spawn-error') {
      // A remote runner-agent lost to an EC2 Spot reclaim fails the step with the
      // spot_reclaimed marker (the fleet reaper sets it when the agent reported an
      // IMDS interruption notice before its lease expired). Classify those as
      // `spot_reclaimed` so the orchestrator's retry path earns the generous
      // reclaim generation cap; every other spawn failure stays the conservative
      // `container_unavailable`. Both are infra-class, so the retry path is the
      // same — only the cap differs.
      const failureReason = detailIsSpotReclaim(runOutcome.detail)
        ? 'spot_reclaimed'
        : 'container_unavailable';
      return finishStepSequence(
        deps,
        opts,
        terminate(
          stmts,
          opts.runId,
          'infra_error',
          failureReason,
          `step ${stepIndex} (${displayName}) failed to spawn: ${runOutcome.detail}`,
          activeSecondsBilled,
          stepResults,
          runOutcome.detail,
          failedStep,
          writeRunTerminal,
        ),
      );
    }

    // A non-zero exit whose output is the Go `context canceled` signature with
    // NO genuine test-failure summary is the CI runner being torn down /
    // cancelled mid-step (OOM on a memory-capped job, the inner dockerd killed,
    // an EC2 Spot reclaim, or a sibling/whole-run abort catching this in-flight
    // job) — NOT a test that failed. Reclassify it infra-class so the
    // orchestrator's one-auto-retry re-runs the job on a fresh runner instead
    // of dispatching a wasted fix round to the agent with every test green. A
    // real red that ALSO logs `context canceled` keeps its failure summary and
    // stays CI-class — the shared `hasTestFailureSummary` guardrail gates both
    // detectors below so neither can mask a genuine red.
    //
    // Two complementary detectors, tried strict-first:
    //   - isRunnerTeardownExit (runner-teardown.ts): the bare `context canceled`
    //     sentinel as the TERMINAL output → `container_unavailable`.
    //   - isRunnerCancellationCollateral (step-cancellation.ts): the broader
    //     signatures the strict detector misses — a docker-daemon
    //     connection-loss marker anywhere, `context deadline exceeded`, the
    //     British spelling, or a colon-wrapped terminal cancel from a
    //     non-docker Go tool (kubectl/gh, possibly under a make/npm wrapper) →
    //     `runner_cancelled`.
    const cancelDetectInput = {
      outputTail: runOutcome.outputTail,
      failureExcerpt: runOutcome.failureExcerpt,
    };
    if (isRunnerTeardownExit(cancelDetectInput)) {
      return finishStepSequence(
        deps,
        opts,
        terminate(
          stmts,
          opts.runId,
          'infra_error',
          'container_unavailable',
          `step ${stepIndex} (${displayName}) runner torn down mid-exec (context canceled) — retrying on a fresh runner`,
          activeSecondsBilled,
          stepResults,
          'runner teardown: context canceled (no test-failure summary)',
          failedStep,
          writeRunTerminal,
        ),
      );
    }
    if (
      !hasTestFailureSummary(cancelDetectInput) &&
      isRunnerCancellationCollateral({
        tail: runOutcome.outputTail,
        excerpt: runOutcome.failureExcerpt,
      })
    ) {
      return finishStepSequence(
        deps,
        opts,
        terminate(
          stmts,
          opts.runId,
          'infra_error',
          'runner_cancelled',
          `step ${stepIndex} (${displayName}) cancelled mid-run (context canceled, exit ${runOutcome.result.exitCode})`,
          activeSecondsBilled,
          stepResults,
          `step ${stepIndex} (${displayName}) cancelled mid-run (context canceled)`,
          failedStep,
          writeRunTerminal,
        ),
      );
    }

    return finishStepSequence(
      deps,
      opts,
      terminate(
        stmts,
        opts.runId,
        'failure',
        'step_failed',
        `step ${stepIndex} (${displayName}) failed with exit ${runOutcome.result.exitCode}`,
        activeSecondsBilled,
        stepResults,
        undefined,
        failedStep,
        writeRunTerminal,
      ),
    );
  }

  // Every step passed. The phase returns immediately — step-log uploads are
  // fully detached background work (fired above) and must never delay finalize
  // completion, status updates, or the downstream ship/push flow. Per the
  // contract, storage trouble cannot affect step/run success.
  return finishStepSequence(deps, opts, {
    status: 'success',
    stepResults,
    activeSecondsBilled,
  });
}

// ─── internals ──────────────────────────────────────────────────────

function stepRunnerTimelineDeps(deps: StepRunnerDeps): TimelineMessageDeps {
  return { stmts: deps.stmts, broadcast: deps.broadcast };
}

function emitChecksRoundTimeline(
  deps: StepRunnerDeps,
  opts: Pick<StepRunnerOptions, 'runId' | 'sessionId'>,
): void {
  const runRow = deps.stmts.getFinalizeRun.get(opts.runId) as FinalizeRunRow | undefined;
  const steps = listFinalizeRunSteps(deps.stmts, opts.runId);
  writeFinalizeChecksRoundTimeline(stepRunnerTimelineDeps(deps), {
    sessionId: opts.sessionId,
    runId: opts.runId,
    round: readFinalizeLoopRound(runRow),
    steps: steps.map((step) => ({
      index: step.index,
      name: step.name,
      state: step.state,
      exitCode: step.exitCode,
      startedAt: step.startedAt,
      endedAt: step.endedAt,
    })),
  });
}

/** Emit one checks-round timeline message after all v2 job shards finish. */
export function emitFinalizeChecksRoundTimeline(
  deps: StepRunnerDeps,
  opts: Pick<RunStepsSequenceOptions, 'runId' | 'sessionId'>,
): void {
  emitChecksRoundTimeline(deps, opts);
}

function finishStepSequence(
  deps: StepRunnerDeps,
  opts: Pick<RunStepsSequenceOptions, 'runId' | 'sessionId' | 'emitChecksTimeline'>,
  result: StepRunResult,
): StepRunResult {
  if (opts.emitChecksTimeline !== false) {
    emitChecksRoundTimeline(deps, opts);
  }
  return result;
}

function finishStepPhase(
  deps: StepRunnerDeps,
  opts: StepRunnerOptions,
  result: StepRunResult,
): StepRunResult {
  emitChecksRoundTimeline(deps, opts);
  return result;
}

interface SingleStepOutcomeBase {
  result: StepResult;
  outputTail: string[];
  failureExcerpt: string[];
  /**
   * The step's full(-ish) output, ready to upload to the log store. Always
   * present even on spawn-error so the viewer can show what little was
   * captured. `null` only for steps that never ran (pre-step budget timeout).
   */
  logSnapshot: StepLogSnapshot;
}

type SingleStepOutcome =
  | ({ kind: 'success' } & SingleStepOutcomeBase)
  | ({ kind: 'non-zero-exit' } & SingleStepOutcomeBase)
  | ({ kind: 'timeout' } & SingleStepOutcomeBase)
  | ({ kind: 'spawn-error'; detail: string } & SingleStepOutcomeBase);

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
  // Output no longer flows into the session message log, so this function
  // doesn't need sessionId/runId/deps — the caller (runStepPhase) owns the
  // log-store upload + step-row persistence once the step resolves.
  const { step, stepIndex, now, spawnStep, hardTimeoutMs } = args;

  return new Promise<SingleStepOutcome>((resolve) => {
    const startedAt = now();
    const tail = new BoundedLineTail(STEP_OUTPUT_TAIL_LINES);
    const excerpt = new FailureExcerptCollector(
      STEP_FAILURE_EXCERPT_CONTEXT_BEFORE,
      STEP_FAILURE_EXCERPT_CONTEXT_AFTER,
      STEP_FAILURE_EXCERPT_MAX_LINES,
    );
    // Accumulate the step's output for the log store (byte-capped). This
    // REPLACES the old per-line `messages` rows + `message` WebSocket
    // broadcasts that flooded the session window and bloated the messages
    // table (a single verbose CI step could write >1M rows). `emit()` also
    // feeds the bounded tail + failure excerpt so triage context is preserved
    // in the result regardless of the store.
    const logAcc = new StepLogAccumulator();
    const emit = (stream: 'stdout' | 'stderr', line: string): void => {
      tail.push(line);
      excerpt.push(line);
      logAcc.push(stream, line);
    };
    let stdoutLines = 0;
    let stderrLines = 0;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;
    let timedOut = false;

    let child: SpawnedStep;
    try {
      // Merge step-level env over the job env so per-step `env:` (e.g.
      // FINALIZE_WARMUP) reaches the process. spawnStep passes these as
      // `docker exec -e` args, so secret values never land in the persisted
      // `run` string.
      const stepEnv = step.env ? { ...(args.env ?? {}), ...step.env } : args.env;
      child = spawnStep({ step, index: stepIndex, cwd: args.cwd, env: stepEnv });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const line = `[spawn-error] ${detail}`;
      emit('stderr', line);
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
        failureExcerpt: excerpt.snapshot(),
        logSnapshot: logAcc.snapshot(),
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
        if (stream === 'stdout') stdoutLines += 1;
        else stderrLines += 1;
        emit(stream, line);
      }
      // Flush the partial buffer if it has grown too large — protects
      // against a step that streams forever without a newline.
      if (trailing.length >= STEP_PARTIAL_LINE_FLUSH_BYTES) {
        const line = stripCarriageReturn(trailing);
        if (stream === 'stdout') stdoutLines += 1;
        else stderrLines += 1;
        emit(stream, line);
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
        stdoutLines += 1;
        emit('stdout', line);
        stdoutBuffer = '';
      }
      if (stderrBuffer.length > 0) {
        const line = stripCarriageReturn(stderrBuffer);
        stderrLines += 1;
        emit('stderr', line);
        stderrBuffer = '';
      }
    };

    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const detail = err.message || String(err);
      const line = `[spawn-error] ${detail}`;
      stderrLines += 1;
      emit('stderr', line);
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
        failureExcerpt: excerpt.snapshot(),
        logSnapshot: logAcc.snapshot(),
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
      const logSnapshot = logAcc.snapshot();
      if (timedOut) {
        resolve({
          kind: 'timeout',
          result,
          outputTail: tail.snapshot(),
          failureExcerpt: excerpt.snapshot(),
          logSnapshot,
        });
        return;
      }
      if (exitCode === 0) {
        resolve({
          kind: 'success',
          result,
          outputTail: tail.snapshot(),
          failureExcerpt: excerpt.snapshot(),
          logSnapshot,
        });
        return;
      }
      resolve({
        kind: 'non-zero-exit',
        result,
        outputTail: tail.snapshot(),
        failureExcerpt: excerpt.snapshot(),
        logSnapshot,
      });
    });
  });
}

/**
 * Bounded wall-clock for the best-effort step-log upload. The terminal step
 * state is ALWAYS persisted before this runs (see runStepPhase), so even a
 * fully hung backend can only delay attaching the log location by this much —
 * never the step's running→passed/failed transition. Override with
 * `FINALIZE_STEP_LOG_UPLOAD_TIMEOUT_MS`.
 */
export const STEP_LOG_UPLOAD_TIMEOUT_MS = (() => {
  const n = Number.parseInt(process.env.FINALIZE_STEP_LOG_UPLOAD_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
})();

/**
 * Upload one step's accumulated output to the log store, then attach its
 * location to the (already-terminal) step row. Fully best-effort, fully
 * detached, and bounded:
 *   - returns immediately when no store is wired (tests) or the step produced
 *     nothing;
 *   - YIELDS a microtask before doing any work, so the CPU-heavy serialization
 *     + compression inside `logStore.write` (JSON.stringify + gzip over up to
 *     STEP_MAX_LOG_BYTES) runs OFF the step critical path — the next step's
 *     spawn and a failed step's fix dispatch are never blocked by it;
 *   - a store error or a write that exceeds {@link STEP_LOG_UPLOAD_TIMEOUT_MS}
 *     is swallowed (logged) so blob-storage trouble can never fail a green step
 *     — the viewer simply shows no stored output.
 *
 * `attempt` is this execution's nonce (the step row's `log_attempt`, minted at
 * announceStepStart). It is woven into the blob key (unique per execution) AND
 * used to GUARD the attach UPDATE: if the same (runId, stepIndex) was
 * re-executed (e.g. a v2 job retried within the run), the row carries a NEW
 * nonce, so a stale earlier upload's attach matches zero rows and cannot
 * clobber the newer execution's location.
 */
async function uploadAndAttachStepLog(
  deps: StepRunnerDeps,
  runId: string,
  stepIndex: number,
  snapshot: StepLogSnapshot | null,
  attempt: string,
): Promise<void> {
  if (!deps.logStore || !snapshot || snapshot.totalLines === 0) return;
  // Hand control back to the caller before any encode/compress/upload work.
  await Promise.resolve();
  let log: StepLogPersist;
  try {
    log = await withTimeout(
      deps.logStore.write(runId, stepIndex, snapshot, attempt),
      STEP_LOG_UPLOAD_TIMEOUT_MS,
    );
  } catch (err) {
    console.warn(
      `[finalize-step-runner] step-log upload failed run=${runId} step=${stepIndex}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  try {
    // Guarded on (run_id, step_index, log_attempt): a stale attempt's attach
    // matches no row once the step has been re-executed with a new nonce.
    deps.stmts.attachFinalizeRunStepLog.run(
      log.storage_kind,
      log.storage_bucket,
      log.storage_region,
      log.key,
      log.lines,
      log.truncated ? 1 : 0,
      runId,
      stepIndex,
      attempt,
    );
  } catch (err) {
    console.warn(
      `[finalize-step-runner] attach step-log location failed run=${runId} step=${stepIndex}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Resolve `p` or reject with a timeout error after `ms`. The underlying
 * promise is left to settle on its own (a hung S3 put can't be cancelled) —
 * we just stop waiting on it so the step loop proceeds.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
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
  meta?: StepPersistMeta,
): string {
  const startedAt = Date.now();
  persistFinalizeRunStep(
    deps.stmts,
    runId,
    stepIndex,
    step.name,
    'running',
    null,
    startedAt,
    null,
    meta,
  );
  // Mint a fresh per-execution nonce and CLEAR any prior log location. This is
  // what makes a re-run/retry never display the previous attempt's blob (even
  // if this attempt's upload later fails). The nonce flows to the upload + the
  // guarded attach so a stale earlier upload can't reattach onto this row.
  const attempt = randomUUID();
  try {
    deps.stmts.beginFinalizeRunStepAttempt.run(attempt, runId, stepIndex);
  } catch (err) {
    console.warn(
      `[finalize-step-runner] begin step attempt failed run=${runId} step=${stepIndex}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  try {
    deps.broadcast({
      type: 'finalize_run_step_state',
      run_id: runId,
      session_id: sessionId,
      step_index: stepIndex,
      step_name: step.name,
      state: 'running',
      ...(meta?.jobId ? { job_id: meta.jobId } : {}),
      ...(meta?.matrixKey ? { matrix_key: meta.matrixKey } : {}),
    });
  } catch (err) {
    console.warn(
      `[finalize-step-runner] step-start broadcast failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return attempt;
}

/**
 * Persist the terminal step state + broadcast it. Terminal state only — the log
 * location is attached separately, AFTER this, via the per-execution nonce
 * minted at {@link announceStepStart}, so a slow upload can't hold the step in
 * `running` (see uploadAndAttachStepLog).
 */
function announceStepEnd(
  deps: StepRunnerDeps,
  sessionId: string,
  runId: string,
  stepIndex: number,
  step: CiStep,
  exitCode: number,
  meta?: StepPersistMeta,
): void {
  const endedAt = Date.now();
  persistFinalizeRunStep(
    deps.stmts,
    runId,
    stepIndex,
    step.name,
    exitCode === 0 ? 'passed' : 'failed',
    exitCode,
    null,
    endedAt,
    meta,
  );
  try {
    deps.broadcast({
      type: 'finalize_run_step_state',
      run_id: runId,
      session_id: sessionId,
      step_index: stepIndex,
      step_name: step.name,
      state: exitCode === 0 ? 'passed' : 'failed',
      exit_code: exitCode,
      ...(meta?.jobId ? { job_id: meta.jobId } : {}),
      ...(meta?.matrixKey ? { matrix_key: meta.matrixKey } : {}),
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
  sessionId: string,
  phase: FinalizeRunPhase,
  status: FinalizeRunStatus,
): void {
  stmts.updateFinalizeRunPhase.run(phase, status, runId);
  broadcast({
    type: 'finalize_run_phase_changed',
    run_id: runId,
    session_id: sessionId,
    phase,
    status,
  });
}

function persistFinalizeRunStep(
  stmts: StepRunnerDeps['stmts'],
  runId: string,
  stepIndex: number,
  name: string,
  state: 'queued' | 'running' | 'passed' | 'failed' | 'skipped',
  exitCode: number | null,
  startedAt: number | null,
  endedAt: number | null,
  meta?: StepPersistMeta,
): void {
  try {
    // The upsert intentionally does NOT touch the log-location columns — those
    // are owned by beginFinalizeRunStepAttempt (clear + nonce on start) and
    // attachFinalizeRunStepLog (set on upload). A state transition can never
    // resurrect a prior execution's stale location.
    stmts.upsertFinalizeRunStep.run(
      runId,
      stepIndex,
      name,
      state,
      exitCode,
      startedAt,
      endedAt,
      meta?.jobId ?? null,
      meta?.matrixKey ?? null,
    );
  } catch (err) {
    console.warn(
      `[finalize-step-runner] upsertFinalizeRunStep failed run=${runId} step=${stepIndex}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
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
  writeRunTerminal = true,
): StepRunResult {
  // `_detail` is intentionally unused inside this helper — the failure
  // detail surfaces via the per-line `addMessage` stream and the §7
  // fix-dispatch body the orchestrator builds from `failedStep`. We keep
  // it on the signature so future tooling (a structured failure log,
  // telemetry, etc.) has an obvious place to plug in without re-threading
  // every call-site.
  //
  // `writeRunTerminal === false` is the v2 matrix shard path: a single shard
  // must NOT stamp the run-level terminal status, because its siblings are
  // still in flight and the orchestrator writes the one authoritative terminal
  // after aggregating every shard. We still return the failure-shaped result so
  // the job runner records the per-job state and the orchestrator sees the red.
  if (writeRunTerminal) {
    if (status === 'failure') {
      stmts.failFinalizeRun.run('failed', failureReason, runId);
    } else if (status === 'timeout') {
      stmts.failFinalizeRun.run('timed_out', failureReason, runId);
    }
  }
  // No-op on `'infra_error'` — see doc comment above. The orchestrator
  // is responsible for either spawning the retry row or persisting
  // `failFinalizeRun('infra_error', ...)` once the retry budget is spent.
  return {
    status,
    stepResults,
    activeSecondsBilled,
    ...(failureReason ? { failureReason } : {}),
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

/**
 * Streaming collector that extracts a "what actually failed" excerpt from an
 * arbitrarily long, possibly noisy output stream — without buffering the
 * whole stream. It keeps a small rolling window of the most recent lines so
 * that, when a {@link FAILURE_SIGNAL_RE} line arrives, it can emit a few
 * lines of leading context, the signal line, and a bounded run of trailing
 * lines. Memory is O(before + maxLines) regardless of total output length,
 * so a sidecar that prints megabytes after the failure can never evict the
 * real signal the way a fixed trailing tail does.
 *
 * Multiple failure regions accumulate into one excerpt; once it would exceed
 * {@link maxLines} the oldest lines are dropped, biasing the result toward
 * the most recent failure (typically the final summary + stack trace).
 */
class FailureExcerptCollector {
  private readonly recent: string[] = [];
  private readonly excerpt: string[] = [];
  private afterRemaining = 0;
  private active = false;
  private matched = false;

  constructor(
    private readonly before: number,
    private readonly after: number,
    private readonly maxLines: number,
  ) {}

  push(line: string): void {
    if (FAILURE_SIGNAL_RE.test(line)) {
      if (!this.active) {
        // Entering a failure region. `recent` only ever holds lines that were
        // NOT already captured into `excerpt` (see the else branch), so seeding
        // it as leading context can never duplicate lines from a prior region.
        // A non-empty `recent` here means uncaptured lines accumulated since
        // the last region — a genuine gap — so mark it with a separator first.
        if (this.recent.length > 0 && this.excerpt.length > 0) {
          this.excerpt.push('   …');
        }
        for (const r of this.recent) this.excerpt.push(r);
        this.recent.length = 0;
        this.active = true;
      }
      this.matched = true;
      this.excerpt.push(line);
      this.afterRemaining = this.after;
    } else if (this.active) {
      // Trailing context for the active region — captured, so it is NOT added
      // to `recent` (that would re-seed it as leading context on re-entry).
      this.excerpt.push(line);
      this.afterRemaining -= 1;
      if (this.afterRemaining <= 0) this.active = false;
    } else {
      // Outside any failure region: keep a rolling window of the most recent
      // uncaptured lines so the next region can show what led up to it.
      this.recent.push(line);
      while (this.recent.length > this.before) this.recent.shift();
    }

    while (this.excerpt.length > this.maxLines) this.excerpt.shift();
  }

  snapshot(): string[] {
    return this.matched ? [...this.excerpt] : [];
  }
}

export const __test = {
  BoundedLineTail,
  FailureExcerptCollector,
  FAILURE_SIGNAL_RE,
  stripCarriageReturn,
  withTimeout,
  STEP_ACTIVE_SECONDS_PER_STEP,
  TASKS_PHASE_ENTRY_ACTIVE_SECONDS,
};
