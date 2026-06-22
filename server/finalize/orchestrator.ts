/**
 * orchestrator.ts — Finalize Code Changes, top-level state machine.
 *
 * Owns the lifecycle of a single finalize run from trigger to push-or-abort.
 * Sequences the four phase modules (`rebase`, `ci-config`, `reviewer-dispatch`,
 * `step-runner`), drives the §3 fix-dispatch loop, enforces the §13
 * active-time budget, and finally fires the §9 push gate. The mapping from
 * design doc to module is:
 *
 *   §3 phase 1  rebase           → `./rebase.ts`
 *   §3 phase 2  parse ci.yaml    → `./ci-config.ts`
 *   §3 phase 3  reviewer         → `./reviewer-dispatch.ts`
 *   §3 phase 4  tasks            → `./step-runner.ts`
 *   §3 phase 5  combined gate    → this file
 *   §3 phase 6  fix dispatch     → `./fix-dispatch.ts`
 *   §3 phase 7  push gate        → this file (head_sha invariant)
 *   §3 phase 8  push             → injected `pushAndCreatePr` dep
 *                                  (sibling card `5c34b2de`)
 *
 * Loop invariant (§3): every fix dispatch re-enters from rebase. Prior
 * reviewer verdicts and step results are stale after a new commit; the
 * push gate is the only place those signals are trusted as current.
 *
 * Idempotency (§4 / §12): one in-flight row per
 * `sha256(project_id|branch|head_sha)`. Re-triggering with the same
 * `head_sha` returns the existing row; a new commit opens a new row. The
 * UNIQUE constraint on `idempotency_key` is the authoritative gate — the
 * orchestrator catches the collision and never spawns a second run on top
 * of an in-flight one.
 *
 * Cancellation (§12): a caller-supplied `CancelSignal` (re-used from the
 * fix-dispatch helper) is honored at every awaitable boundary. Cancel is
 * UI-only at v0; the only thing that prevents a runaway loop without a
 * cancel is the 60-min active-time budget (§13) and the push gate's
 * head-sha invariant (§9).
 *
 * Non-throwing contract: every failure mode resolves with an
 * {@link OrchestratorOutcome}. The state machine never rejects its
 * promise — phase runners that throw are caught here and surfaced as
 * `infra_error` for the trigger to log + present.
 */
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  AppConfig,
  BroadcastFn,
  FinalizeRunMode,
  FinalizeRunPhase,
  FinalizeRunRow,
  FinalizeRunStatus,
  KanbanCardRow,
  Project,
  Stmts,
} from '../types.js';
import { mergeProjectSecretsSpawnEnv } from '../project-secrets-spawn.js';
import { getActiveOrgId } from '../orgs.js';
import { mergeFinalizeGitSpawnEnv } from './finalize-git-env.js';
import { FINALIZE_BUDGET_SECONDS, runRebasePhase } from './rebase.js';
import type { RebasePhaseOutcome } from './rebase.js';
import { loadCiConfigFromFile } from './ci-config.js';
import type { AnyCiConfig, CiConfigParseResult } from './ci-config.js';
import { runReviewerDispatch } from './reviewer-dispatch.js';
import type {
  ReviewerDispatchOutcome,
  ReviewerLocalDiffInputs,
  RunReviewerOnLocalDiff,
} from './reviewer-dispatch.js';
import { runStepPhase } from './step-runner.js';
import type { StepRunResult } from './step-runner.js';
import { runJobPhase } from './job-runner.js';
import type { FinalizeStepLogStore } from './finalize-log-store.js';
import { dispatchFixMessage, type SpawnFixTurnFn } from './fix-dispatch.js';
import type {
  CancelSignal,
  FixDispatchResult,
  FixDispatchTrigger,
  TurnEndSubscriber,
} from './fix-dispatch.js';
import { evaluatePushGate } from './push-gate.js';
import { NOOP_CARD_LIFECYCLE } from './card-lifecycle.js';
import type { CardLifecycle } from './card-lifecycle.js';
import {
  broadcastActiveSeconds,
  FINALIZE_BUDGET_HARD_CEILING_SECONDS,
  getRunFamilyActiveSeconds,
  isBudgetExhausted as budgetIsExhausted,
  postTimeoutDispatchMessage,
  resolveBudgetSeconds,
} from './budget.js';
import {
  isInfraFailureReason,
  openInfraRetryRun,
  postInfraTerminalMessage,
  resolveRetryGenerationCap,
} from './infra-retry.js';
import {
  recordFixDispatchCount,
  recordReviewerVerdict,
  recordRunActiveSeconds,
  recordRunCompleted,
  recordRunStarted,
  recordRunWallSeconds,
  recordStalledNoResponse,
  recordStepResult,
} from './metrics.js';
import {
  readFinalizeLoopRound,
  writeFinalizeFlakeRecoveredTimeline,
  writeFinalizeReadyToPushTimeline,
  writeFinalizeRebaseResultTimeline,
  writeFinalizeRunStartedTimeline,
  writeFinalizeRunTerminalTimeline,
  type TimelineMessageDeps,
} from './timeline-message.js';
import { classifyRunFlakeRecovery, recordJobAttemptsForRound } from './flake-gate.js';
import { blockedGateResult, serializeFlakeGate, type FlakeGateResult } from './flake-recovery.js';
import { loadActiveQuarantine, recordRunTestHistory } from './quarantine-gate.js';
import { applyQuarantineToGate, describeExcused } from './quarantine.js';
import { computeIdempotencyKey, DEFAULT_CI_CONFIG_RELATIVE_PATH } from './finalize-keys.js';

export { computeIdempotencyKey, DEFAULT_CI_CONFIG_RELATIVE_PATH };

const execFileAsync = promisify(execFile);

type ReadyToPushAutomationHook = (sessionId: string, runId: string) => void;
let readyToPushAutomationHook: ReadyToPushAutomationHook | null = null;

/** Wired from `index.ts` to avoid orchestrator ↔ automation-runner import cycle. */
export function setReadyToPushAutomationHook(fn: ReadyToPushAutomationHook | null): void {
  readyToPushAutomationHook = fn;
}

function notifyReadyToPushAutomationHook(
  sessionId: string | null | undefined,
  runId: string,
): void {
  if (!sessionId || !readyToPushAutomationHook) return;
  try {
    readyToPushAutomationHook(sessionId, runId);
  } catch (err) {
    console.warn(
      `[finalize-orchestrator] ready-to-push automation hook failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ─── Public constants ─────────────────────────────────────────────────

/**
 * Cap on outer fix-dispatch loops. Per §13 the only ceiling is the
 * 60-minute active-time budget; this constant is a runaway-loop backstop
 * so a pathological "session immediately ends its turn without committing"
 * cannot spin forever before the budget catches up. Deliberately generous —
 * a healthy run almost never exceeds 5 loops.
 */
export const MAX_FIX_DISPATCH_LOOPS = 50;

// ─── Types ────────────────────────────────────────────────────────────

/**
 * Push-step seam. Sibling card `5c34b2de` will land the real
 * implementation (Reviewer App auth, `git push --force-with-lease`,
 * `gh pr create`, body-marker injection via `ensurePrBodyMarker`). Until
 * then the orchestrator only invokes this via the injected dep so the
 * state machine can be exercised end-to-end against a fake.
 */
export interface PushAndCreatePrArgs {
  runId: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  headSha: string;
  card: KanbanCardRow;
  project: Project;
  /**
   * Session that owns this push. When set, the push/PR step prefers the
   * session owner's personal GitHub token over the org-owner token, so the
   * push and `gh pr create` are attributed to the triggering user rather than
   * an arbitrary org Owner. Falls back to the org owner when the session owner
   * has no usable token (e.g. no connected GitHub identity).
   */
  sessionId?: string | null;
  /** Hub user id stamped on Agent Hub-native PR rows. Set by push-run. */
  authorUserId?: string | null;
  env?: NodeJS.ProcessEnv;
}

export interface PushAndCreatePrResult {
  prUrl: string;
}

export type PushAndCreatePrFn = (args: PushAndCreatePrArgs) => Promise<PushAndCreatePrResult>;

/**
 * Pre-flight sessionizer for cards whose `session_id` is null at trigger
 * time. Production wires this to the regular session-spawn path
 * (`server/sessions.ts`); tests pass a fake that returns canned ids.
 *
 * Returning `null` is treated as "could not spawn a session" — the
 * orchestrator surfaces this as `failed` with reason `worktree_create_failed`
 * because the dispatch loop has no surface to talk to.
 */
export interface SpawnSessionArgs {
  card: KanbanCardRow;
  project: Project;
  triggeredByUserId: string;
}

export interface SpawnedSession {
  sessionId: string;
  worktreePath: string;
}

export type SpawnSessionFn = (args: SpawnSessionArgs) => Promise<SpawnedSession | null>;

export interface OrchestratorDeps {
  config: Pick<AppConfig, 'personalOAuth'>;
  stmts: Pick<
    Stmts,
    | 'getFinalizeRun'
    | 'getFinalizeRunByIdempotencyKey'
    | 'insertFinalizeRun'
    | 'updateFinalizeRunPhase'
    | 'updateFinalizeRunActiveSeconds'
    | 'updateFinalizeRunSessionId'
    | 'updateFinalizeRunWorktreePath'
    | 'updateFinalizeRunLoopRound'
    | 'updateFinalizeRunReviewerVerdict'
    | 'failFinalizeRun'
    | 'markFinalizeRunReadyToPush'
    | 'getLatestChecksRunForSession'
    | 'getLatestReviewRunForSession'
    | 'markFinalizeRunPushed'
    | 'updateFinalizeRunPrUrl'
    | 'insertReviewerThread'
    | 'deleteReviewerThreadsForRun'
    | 'addMessage'
    | 'touchSession'
    | 'getMessageById'
    | 'upsertFinalizeRunStep'
    | 'beginFinalizeRunStepAttempt'
    | 'attachFinalizeRunStepLog'
    | 'listFinalizeRunStepsForRun'
    | 'upsertFinalizeRunJob'
    | 'listFinalizeRunJobsForRun'
    | 'upsertFinalizeRunJobAttempt'
    | 'listFinalizeRunJobAttemptsForRun'
    | 'setFinalizeRunFlakeRecoveredJobs'
    | 'upsertFinalizeTestHistory'
    | 'listFinalizeQuarantineForProject'
    | 'listReviewerThreadsForRun'
    | 'insertFinalizeMetric'
  >;
  broadcast: BroadcastFn;
  /**
   * Store for per-step CI output blobs (S3 or local dir). Forwarded into the
   * step / job phases so output is written here instead of streamed into the
   * session message log. Optional: when omitted, step output is not persisted
   * (the bounded tail / failure excerpt still drive triage + fix dispatch).
   */
  logStore?: FinalizeStepLogStore;
  /**
   * Wrap a synchronous body in a `better-sqlite3` transaction. Production
   * threads `db.transaction(...)` through here; tests pass an identity
   * wrapper. Surfaced separately so the reviewer-dispatch sub-call inside
   * the orchestrator can honor its own transactional contract.
   */
  transactional?: <T>(fn: () => T) => T;
  /** The reviewer driver — see {@link RunReviewerOnLocalDiff}. */
  runReviewer: RunReviewerOnLocalDiff;
  /** Turn-end signal subscriber — see {@link TurnEndSubscriber}. */
  turnEnd: TurnEndSubscriber;
  /**
   * Push step. Injected so the sibling card `5c34b2de` (Reviewer App
   * push) can land independently; tests inject a fake. Required at
   * production wiring time — there is no sensible default.
   */
  pushAndCreatePr: PushAndCreatePrFn;
  /**
   * Spawn a fresh agent session for a card whose `session_id` is null at
   * trigger time. Production wires to the regular session-create path;
   * tests inject a stub. Optional — runs with a pre-resolved session id
   * never invoke it.
   */
  spawnSession?: SpawnSessionFn;
  /**
   * Resolve the worktree's current HEAD SHA. Used by the push gate (§9)
   * to refuse pushing when the head moved between green-and-approved and
   * push (the session committed an extra fix mid-window).
   */
  resolveHeadSha?: (worktreePath: string, env?: NodeJS.ProcessEnv) => Promise<string>;
  /**
   * The conflict-resolution dispatcher the rebase phase uses when a
   * non-trivial conflict appears. Production wires the live
   * `dispatchAndWaitForTurnEnd`; tests inject a stub.
   */
  dispatchAndWaitForTurnEnd: (args: {
    sessionId: string;
    cardId: string;
    body: string;
  }) => Promise<{ userMessagePersisted: boolean }>;
  /**
   * Kanban-card surface mirror. The orchestrator calls hook methods at
   * each user-actionable transition (start, rebase outcome, reviewer
   * verdict, step failure, terminal). Optional — defaults to a no-op so
   * the existing test suites stay clean; production wiring should always
   * inject a {@link createCardLifecycle} instance bound to the run's
   * card + project.
   */
  cardLifecycle?: CardLifecycle;
  /** Phase-runner overrides for tests. Defaults import the real helpers. */
  runRebasePhase?: typeof runRebasePhase;
  loadCiConfigFromFile?: typeof loadCiConfigFromFile;
  runReviewerDispatch?: typeof runReviewerDispatch;
  runStepPhase?: typeof runStepPhase;
  runJobPhase?: typeof runJobPhase;
  dispatchFixMessage?: typeof dispatchFixMessage;
  /** Spawn originating agent after §7 fix dispatch (see `spawn-fix-turn.ts`). */
  spawnFixTurn?: SpawnFixTurnFn;
  /** Override the active-time budget cap (seconds). Defaults to {@link FINALIZE_BUDGET_SECONDS}. */
  budgetSeconds?: number;
  /** Deterministic clock injection (defaults to `Date.now`). */
  now?: () => number;
  /** Deterministic id minter (defaults to `randomUUID`). */
  newId?: () => string;
  /** Log sink (defaults to `console.warn`). */
  log?: (msg: string) => void;
}

export interface OrchestratorOptions {
  card: KanbanCardRow;
  project: Project;
  /** Feature branch the session committed to. */
  branch: string;
  /** Head SHA at trigger time — locked into the idempotency key. */
  headSha: string;
  /** Default branch on origin (e.g. `'main'`). */
  baseBranch: string;
  /**
   * Session's existing worktree path. Optional — when omitted the
   * orchestrator spawns a session (if the card has none) and uses the
   * spawned worktree.
   */
  worktreePath?: string | null;
  /**
   * Existing session id. Optional — when null the orchestrator spawns a
   * session via {@link OrchestratorDeps.spawnSession}.
   */
  sessionId?: string | null;
  /** Trigger surface — see §2. */
  triggerSource: 'ui_button' | 'agent_block';
  /**
   * Which phases the run executes. Defaults to `'full'` (rebase + review
   * + checks). The split manual buttons pass `'checks'` (rebase + CI) or
   * `'review'` (rebase + reviewer). Folded into the idempotency key so
   * a checks-only and a review-only run can co-exist on one head SHA.
   */
  mode?: FinalizeRunMode;
  /**
   * Manual re-run discriminator. When a user explicitly re-triggers a
   * Finalize phase against a head SHA whose previous run already reached a
   * terminal state, the kickoff layer bumps this so the re-run gets its own
   * idempotency key (and thus its own row + timeline bubble) instead of
   * deduping ("Reused") onto the finished run. Defaults to 1, which keeps
   * the historical idempotency key byte-identical for first runs and every
   * automated trigger.
   */
  attempt?: number;
  /** Acting user id (clicker or autonomous owner). */
  triggeredByUserId: string;
  /** Git identity snapshot at start time — locked into the row. */
  authorName: string;
  authorEmail: string;
  /**
   * Absolute path to `.agent-hub/ci.yaml`. Defaults to
   * `<worktreePath>/.agent-hub/ci.yaml`. The parser is path-agnostic so
   * deploys with sibling-directory config can override.
   */
  ciConfigPath?: string;
  /** Env injected into every spawned child (git, step shell). */
  env?: NodeJS.ProcessEnv;
  /** Cancellation signal — honored at every awaitable boundary. */
  signal?: CancelSignal;
  /** Optional retry parent: this run is the one infra-failure retry. */
  retryOfRunId?: string | null;
  /**
   * Per-project stall-watchdog overrides; threaded through to fix dispatch.
   */
  stallNotifyAfterMs?: number;
  stallAfterMs?: number;
}

/**
 * Terminal outcome of an orchestrator invocation. `'reused'` carries the
 * existing row id without re-driving the state machine — the caller can
 * subscribe to WebSocket events to follow the live run.
 */
export type OrchestratorOutcome =
  | { kind: 'pushed'; runId: string; prUrl: string }
  | { kind: 'ready_to_push'; runId: string }
  | {
      kind: 'failed';
      runId: string;
      status: FinalizeRunStatus;
      failureReason: string;
      detail?: string;
    }
  | { kind: 'cancelled'; runId: string }
  | { kind: 'stalled'; runId: string }
  | { kind: 'reused'; runId: string; status: FinalizeRunStatus };

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Drive a finalize run end-to-end. The function returns when the run
 * reaches a terminal state — `pushed`, `failed`, `timed_out`,
 * `infra_error`, `cancelled`, `stalled_no_response`, or the `reused`
 * short-circuit when another in-flight row already covers this
 * (project, branch, head_sha) tuple.
 *
 * The state machine is **non-throwing**: every failure path resolves
 * with a tagged {@link OrchestratorOutcome}. Errors are logged via
 * {@link OrchestratorDeps.log} and converted into `infra_error` rather
 * than propagated.
 */
export async function runFinalize(
  deps: OrchestratorDeps,
  opts: OrchestratorOptions,
): Promise<OrchestratorOutcome> {
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  // §3 decision trace gate. Default ON — one structured `[finalize-trace]`
  // line per phase transition lands in the same sink as error lines (PM2
  // logs in prod) so an operator debugging a "stuck" / "acting funny" run
  // can reconstruct the exact implementation→test→review→push path without
  // a debugger. Read once per run; FINALIZE_TRACE=off (or 0/false) silences.
  const traceEnabled = finalizeTraceEnabled();
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  // The cap is the lesser of the dep-injected budget (tests) and the
  // §13 hard ceiling. Narrowed further once ci.yaml is parsed (a v0
  // ci.yaml `timeout_minutes` may lower the cap but never raise it —
  // {@link resolveBudgetSeconds} enforces the ceiling).
  let budgetSeconds = Math.min(
    deps.budgetSeconds ?? FINALIZE_BUDGET_SECONDS,
    FINALIZE_BUDGET_HARD_CEILING_SECONDS,
  );
  // The kanban-card mirror. Default no-op keeps the existing test deps
  // shape minimal — production injects a real lifecycle bound to
  // (cardId, projectId). See `card-lifecycle.ts`.
  const lifecycle = deps.cardLifecycle ?? NOOP_CARD_LIFECYCLE;
  const runRebase = deps.runRebasePhase ?? runRebasePhase;
  const loadCi = deps.loadCiConfigFromFile ?? loadCiConfigFromFile;
  const runReview = deps.runReviewerDispatch ?? runReviewerDispatch;
  const runSteps = deps.runStepPhase ?? runStepPhase;
  const runJobs = deps.runJobPhase ?? runJobPhase;
  const dispatchFix = deps.dispatchFixMessage ?? dispatchFixMessage;
  const resolveHead = deps.resolveHeadSha ?? defaultResolveHeadSha;
  // `transactional` is technically optional on the type so unit tests can
  // omit it (they pass plain in-memory stmts where atomicity is
  // meaningless). Production callers MUST inject `db.transaction(...)`
  // from `better-sqlite3`, otherwise the reviewer-dispatch helper's
  // threads-plus-verdict write loses atomicity and a mid-commit crash
  // can leave dangling threads or an orphaned verdict. We warn once per
  // run (not throw — refusing to run is worse than running non-atomic)
  // so the gap surfaces in logs the first time it bites. `NODE_ENV`
  // gates the warning so the chatter doesn't bleed into the test suite.
  if (!deps.transactional && process.env.NODE_ENV !== 'test') {
    log(
      '[finalize-orchestrator] transactional dep not injected — reviewer ' +
        'thread + verdict writes will NOT be atomic. Wire `db.transaction(...)` ' +
        'from better-sqlite3 at the production call-site.',
    );
  }

  const spawnEnv: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
  mergeProjectSecretsSpawnEnv(spawnEnv, {
    projectId: opts.project.id,
    sessionId: opts.sessionId ?? null,
    overwriteExisting: true,
  });
  await mergeFinalizeGitSpawnEnv(spawnEnv, {
    config: deps.config,
    project: opts.project,
    sessionId: opts.sessionId ?? null,
  });

  // Which phases this run executes. `mode` defaults to 'full' (the one
  // Finalize button = rebase + reviewer + checks). Legacy 'checks' / 'review'
  // rows from before the buttons were collapsed, and any automation still
  // targeting a single phase, keep their historical gating.
  const mode: FinalizeRunMode = opts.mode ?? 'full';
  const reviewRequired = mode !== 'checks';
  const checksRequired = mode !== 'review';

  // ─── Idempotency: dedup at the (project, branch, head_sha, mode) level ─
  const idempotencyKey = computeIdempotencyKey({
    projectId: opts.project.id,
    branch: opts.branch,
    headSha: opts.headSha,
    mode,
    attempt: opts.attempt,
  });
  const existing = deps.stmts.getFinalizeRunByIdempotencyKey.get(idempotencyKey) as
    | FinalizeRunRow
    | undefined;
  if (existing) {
    return { kind: 'reused', runId: existing.id, status: existing.status };
  }

  // ─── Open the row + broadcast `finalize_run_created` ────────────────
  const runId = newId();
  const startedAt = now();
  try {
    deps.stmts.insertFinalizeRun.run(
      runId,
      opts.card.id,
      opts.sessionId ?? null,
      opts.project.id,
      opts.branch,
      opts.headSha,
      idempotencyKey,
      'queued',
      null,
      opts.triggerSource,
      opts.worktreePath ?? null,
      opts.triggeredByUserId,
      opts.authorName,
      opts.authorEmail,
      opts.retryOfRunId ?? null,
      startedAt,
      mode,
      // `job_filter` is a legacy nullable column; new runs never set it.
      null,
    );
  } catch (err) {
    // UNIQUE collision race: another caller raced us between the lookup
    // and the insert. Re-fetch and surface as reused — same outcome the
    // single-caller idempotency path would have produced.
    const racing = deps.stmts.getFinalizeRunByIdempotencyKey.get(idempotencyKey) as
      | FinalizeRunRow
      | undefined;
    if (racing) {
      return { kind: 'reused', runId: racing.id, status: racing.status };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log(`[finalize-orchestrator] insert failed for key=${idempotencyKey}: ${msg}`);
    return {
      kind: 'failed',
      runId,
      status: 'infra_error',
      failureReason: 'container_unavailable',
      detail: `insert finalize_runs failed: ${msg}`,
    };
  }
  deps.broadcast({
    type: 'finalize_run_created',
    run_id: runId,
    card_id: opts.card.id,
    session_id: opts.sessionId ?? null,
    trigger_source: opts.triggerSource,
  });
  // §14 metric: one row per Finalize run that actually started.
  recordRunStarted(
    { stmts: deps.stmts, now, log },
    { projectId: opts.project.id, runId, triggerSource: opts.triggerSource },
  );
  // Mirror the run's start onto the kanban card: move card → In Progress
  // (idempotent if already there) and post the "Finalize started" comment.
  // Idempotency on re-trigger is handled at the row-insert dedup above —
  // a `'reused'` short-circuit never reaches this point, so we don't
  // double-comment when the user clicks Finalize twice against the same
  // head sha.
  lifecycle.onStarted({ runId, triggerSource: opts.triggerSource });

  // §14 fix-dispatch counter — incremented in the attempt loop, sealed
  // into a `finalize_fix_dispatch_count` histogram at the terminal write.
  // Shared across the original attempt and its one infra retry so the
  // metric reflects the whole family's effort, not just attempt 2's.
  const fixDispatchCounter = { value: 0 };

  /**
   * Emit the §14 terminal metric set for a finalize run.
   *
   * Population definition (kept symmetric with `recordRunStarted`):
   *
   * - `finalize_run_completed`, `_active_seconds`, `_wall_seconds`: one
   *   row per **attempt**. So a family that infra-retries logs two of
   *   each — one for the original (status = `infra_error`), one for the
   *   retry (status = whatever it landed on). `recordRunStarted` mirrors
   *   this: one row per attempt-row started, including the retry row.
   *
   * - `finalize_fix_dispatch_count`: emitted **only on the final terminal
   *   of the family** (`isFamilyTerminal = true`). The counter is
   *   cumulative across attempts; emitting it twice would produce two
   *   correlated samples where the second contains the first, skewing
   *   the histogram and the `count(completed) / count(started)`
   *   reconciliation. The single emission carries the family total.
   *
   * Reads the row back so `active_seconds_consumed`, `started_at`, and
   * the live status reflect whatever the terminal write just persisted.
   * Best-effort — caught and logged inside `recordMetric` so a metric
   * DB hiccup never crashes the orchestrator.
   */
  const writeTerminalMetrics = (
    attemptRunId: string,
    statusOverride: string | undefined,
    isFamilyTerminal: boolean,
  ): void => {
    // `statusOverride === undefined` is the `reused` short-circuit signal:
    // the orchestrator never re-counted a reused row at the start, and
    // double-counting at the terminal would skew dashboards. Bail early.
    if (statusOverride === undefined) return;
    let activeSeconds = 0;
    let wallSeconds = 0;
    const status = statusOverride;
    try {
      const row = deps.stmts.getFinalizeRun.get(attemptRunId) as FinalizeRunRow | undefined;
      if (row) {
        activeSeconds = row.active_seconds_consumed ?? 0;
        const endedAt = row.ended_at ?? now();
        wallSeconds = Math.max(0, Math.round((endedAt - row.started_at) / 1000));
      }
    } catch (err) {
      log(
        `[finalize-orchestrator] terminal metrics row read failed for run=${attemptRunId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const metricDeps = { stmts: deps.stmts, now, log };
    recordRunCompleted(metricDeps, {
      projectId: opts.project.id,
      runId: attemptRunId,
      status,
      triggerSource: opts.triggerSource,
    });
    recordRunActiveSeconds(metricDeps, {
      projectId: opts.project.id,
      runId: attemptRunId,
      activeSeconds,
      status,
    });
    recordRunWallSeconds(metricDeps, {
      projectId: opts.project.id,
      runId: attemptRunId,
      wallSeconds,
      status,
    });
    if (isFamilyTerminal) {
      recordFixDispatchCount(metricDeps, {
        projectId: opts.project.id,
        runId: attemptRunId,
        count: fixDispatchCounter.value,
        status,
      });
    }
  };

  // ─── Attempt driver ─────────────────────────────────────────────────
  // The body of a single Finalize attempt — phase loop, session
  // resolution, push gate, terminal writes — lives inside this nested
  // closure so the §10 one-auto-retry path can re-invoke it with a
  // fresh `runId` (the retry row's id) without restating the entire
  // state machine. `runId` is shadowed by the parameter — every helper
  // inside resolves to the per-attempt id, never to the outer-scope
  // original.
  //
  // The closure shares `budgetSeconds` with the outer scope by
  // reference so a ci.yaml narrowing inside attempt 1 carries into
  // attempt 2 (per §13: the cap is family-shared and may only LOWER —
  // both attempts see the same monotonically-narrowing cap). The
  // family-total accounting inside `budgetExhausted` ensures the
  // retry's own bills add to the parent's, not start fresh.
  const driveAttempt = async (
    runId: string,
    retryOfRunId: string | null,
    initialSessionId: string | null,
    initialWorktreePath: string | null,
  ): Promise<OrchestratorOutcome> => {
    // Retain the param so callers reading the type signature see what
    // it is for, even though the body does not branch on it today (the
    // §10 retry gate lives in the outer wrapper). Linters keep us
    // honest with this no-op reference.
    void retryOfRunId;

    // Per-attempt decision tracer. Binds the attempt's `runId` + outer
    // `mode` so call-sites only pass the event name and the fields that
    // distinguish that decision. No-op when `traceEnabled` is false.
    const trace = (event: string, fields: Record<string, unknown> = {}): void => {
      if (!traceEnabled) return;
      log(`[finalize-trace] ${formatTraceFields({ event, run: runId, mode, ...fields })}`);
    };

    // Pre-cancel: caller already aborted before we wired anything up.
    if (opts.signal?.aborted) {
      return cancelTerminal(deps, runId, log);
    }

    // ─── Resolve the session if needed ────────────────────────────────
    // The fix-dispatch loop requires a real session to inject messages
    // into; we resolve up-front so a "session was archived" surface
    // produces a clear failure before we burn rebase time. On the retry
    // attempt we inherit the original's resolved session + worktree
    // path so spawnSession is not re-fired (the session owns the
    // worktree per §6).
    let sessionId: string | null = initialSessionId;
    let worktreePath = initialWorktreePath;
    if (!sessionId && deps.spawnSession) {
      try {
        const spawned = await deps.spawnSession({
          card: opts.card,
          project: opts.project,
          triggeredByUserId: opts.triggeredByUserId,
        });
        if (!spawned) {
          return terminate(
            deps,
            runId,
            'infra_error',
            'worktree_create_failed',
            'spawnSession returned null — no session available for fix dispatch',
            log,
          );
        }
        sessionId = spawned.sessionId;
        worktreePath = spawned.worktreePath;
        deps.stmts.updateFinalizeRunSessionId.run(sessionId, runId);
        deps.stmts.updateFinalizeRunWorktreePath.run(worktreePath, runId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return terminate(
          deps,
          runId,
          'infra_error',
          'worktree_create_failed',
          `spawnSession threw: ${msg}`,
          log,
        );
      }
    }

    if (!sessionId) {
      return terminate(
        deps,
        runId,
        'infra_error',
        'worktree_create_failed',
        'card has no session_id and no spawnSession dep wired',
        log,
      );
    }
    if (!worktreePath) {
      return terminate(
        deps,
        runId,
        'infra_error',
        'worktree_create_failed',
        'no worktree_path available for rebase phase',
        log,
      );
    }

    writeFinalizeRunStartedTimeline(orchestratorTimelineDeps(deps), {
      sessionId,
      runId,
      triggerSource: opts.triggerSource,
      headSha: opts.headSha,
    });

    trace('attempt_start', {
      session: sessionId,
      worktree: worktreePath,
      head: opts.headSha,
      trigger: opts.triggerSource,
      retryOf: retryOfRunId,
      budgetSeconds,
      reviewRequired,
      checksRequired,
    });

    const ciConfigPath = opts.ciConfigPath ?? `${worktreePath}/${DEFAULT_CI_CONFIG_RELATIVE_PATH}`;

    // ─── Main loop: rebase → parse → review → tasks → combined gate ─────
    // Every fix dispatch re-enters at the top of this loop (§3 loop
    // invariant). We pin `lastReviewerVerdict` and `lastStepStatus` PER
    // ITERATION so a stale signal from a prior pass can never escape into
    // the push gate.
    let loopCount = 0;
    // Track the last reviewer + step signals so the combined gate doesn't
    // re-read state from the DB (which would race with the live row).
    let lastReviewerOutcome: ReviewerDispatchOutcome | null = null;
    let lastStepOutcome: StepRunResult | null = null;
    let parsedCi: AnyCiConfig | null = null;
    // §6 no-progress guard: the post-rebase HEAD snapshot the PREVIOUS
    // iteration validated against. A fix dispatch can only change the
    // outcome of review/checks by landing a new commit on the feature
    // branch — which moves this snapshot. If a round re-enters the loop
    // after a fix dispatch with the SAME post-rebase HEAD, the fixer
    // produced no new commit on `opts.branch` (it committed to a
    // different branch, or did not commit at all), so re-running review +
    // checks would reproduce the identical verdict forever. We fail fast
    // here instead of spinning to MAX_FIX_DISPATCH_LOOPS and burning the
    // active-time budget. The push-gate `continue` path never reaches
    // this guard with an unchanged HEAD: it only fires when HEAD MOVED,
    // so the next snapshot necessarily differs.
    let prevValidatedHead: string | null = null;
    // Flake gate (fail-closed): set to false the moment any round's per-round
    // job-attempt history fails to persist. Without complete history, the
    // classifier can't tell a real fix from a laundered flake, so the gate must
    // block automation rather than read clean. Only flips false, never back.
    let attemptHistoryPersisted = true;
    // Whether the v2 jobs (tasks) phase actually ran at least once this run.
    // Drives `expectAttempts`: a v2 run that ran jobs MUST have history, so its
    // absence fails the gate closed; a review-only run never ran jobs and has
    // nothing to classify.
    let ranV2Jobs = false;

    while (loopCount < MAX_FIX_DISPATCH_LOOPS) {
      loopCount += 1;

      try {
        deps.stmts.updateFinalizeRunLoopRound.run(loopCount, runId);
      } catch (err) {
        log(
          `[finalize-orchestrator] loop_round write failed for run=${runId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      trace('loop_enter', { round: loopCount });

      if (opts.signal?.aborted) {
        trace('cancelled', { round: loopCount, at: 'loop_top' });
        return cancelTerminal(deps, runId, log);
      }
      if (budgetExhausted(deps, runId, budgetSeconds, log)) {
        trace('timeout', { round: loopCount, at: 'loop_top', budgetSeconds });
        return timeoutTerminal(deps, runId, opts, sessionId, budgetSeconds, lastStepOutcome, log);
      }

      // ── Phase 1: rebase ─────────────────────────────────────────────
      let rebaseOutcome: RebasePhaseOutcome;
      try {
        rebaseOutcome = await runRebase(
          {
            stmts: deps.stmts,
            broadcast: deps.broadcast,
            dispatchAndWaitForTurnEnd: deps.dispatchAndWaitForTurnEnd,
            budgetSeconds: budgetSeconds,
          },
          {
            runId,
            worktreePath,
            baseBranch: opts.baseBranch,
            featureBranch: opts.branch,
            env: spawnEnv,
            card: opts.card,
            project: opts.project,
          },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return terminate(
          deps,
          runId,
          'infra_error',
          'container_unavailable',
          `rebase phase threw: ${msg}`,
          log,
        );
      }
      // Emit active-seconds tick after rebase (success or fail) so
      // subscribers see the running total. The rebase phase wrote the DB
      // directly; we read back + broadcast.
      broadcastActiveSeconds(deps, runId);
      if (rebaseOutcome.kind === 'failed') {
        trace('rebase', {
          round: loopCount,
          result: 'failed',
          failureReason: rebaseOutcome.failureReason,
        });
        writeFinalizeRebaseResultTimeline(orchestratorTimelineDeps(deps), {
          sessionId,
          runId,
          round: loopCount,
          ok: false,
          detail: rebaseOutcome.detail,
        });
        // Mirror the rebase failure onto the card BEFORE we propagate the
        // failure — `outcomeFromFailed` writes the terminal broadcasts but
        // does not touch the card surface. Only on first iteration to
        // avoid spamming on a fix-dispatch-loop rebase that later fails.
        if (loopCount === 1) {
          lifecycle.onRebaseAborted({ runId, detail: rebaseOutcome.detail });
        }
        // §13: a rebase that fails on `failure_reason = 'timeout'` should
        // surface with the timeout-class behavior (session message with the
        // last attempt output tail). `outcomeFromFailed` already maps the
        // status to `timed_out`; we additionally post the dispatch message.
        if (rebaseOutcome.failureReason === 'timeout') {
          postBudgetTimeoutMessageIfPossible(
            deps,
            runId,
            opts,
            sessionId,
            budgetSeconds,
            lastStepOutcome,
            log,
          );
        }
        return outcomeFromFailed(deps, runId, rebaseOutcome.failureReason, rebaseOutcome.detail);
      }
      if (rebaseOutcome.rebaseKind === 'skipped') {
        trace('rebase', { round: loopCount, result: 'skipped' });
        // Skipped rebases mean we cannot guarantee we're on top of origin/<base>.
        // The rebase phase already wrote `success` to its return value, but the
        // push gate would refuse anyway, so we surface this as failed early
        // with a clear failure_reason.
        if (loopCount === 1) {
          lifecycle.onRebaseAborted({
            runId,
            detail: 'rebase skipped — base branch unavailable or unsafe',
          });
        }
        writeFinalizeRebaseResultTimeline(orchestratorTimelineDeps(deps), {
          sessionId,
          runId,
          round: loopCount,
          ok: false,
          detail: 'rebase skipped — base branch unavailable or unsafe',
        });
        return terminate(
          deps,
          runId,
          'failed',
          'rebase_aborted',
          'rebase skipped — base branch unavailable or unsafe',
          log,
        );
      }
      // First-iteration rebase succeeded. Mirror "clean" vs "conflict
      // dispatched to session" onto the card. We split on
      // `conflictsDispatchedCount` rather than `requiredFix` so the
      // trivial-auto-resolve case (whitespace / lockfile fixups, no
      // session interaction) stays silent — the user does not need to act
      // on it. Subsequent rebase iterations stay silent to keep the
      // comment timeline readable.
      if (loopCount === 1) {
        const dispatched = rebaseOutcome.conflictsDispatchedCount ?? 0;
        if (dispatched > 0) {
          lifecycle.onRebaseConflictDispatched({ runId });
        } else {
          lifecycle.onRebaseClean({ runId });
        }
      }

      // Snapshot the post-rebase HEAD. Everything from here through the
      // push gate is "validation against this specific sha"; the push gate
      // refuses when HEAD differs from this snapshot at push time (§9).
      //
      // Why AFTER rebase, not before: rebase may rewrite the feature
      // branch's commits onto `origin/<base>` and thereby change every
      // local SHA. Capturing pre-rebase would always refuse on the first
      // pass when the upstream actually moved. The snapshot must reflect
      // the tree the reviewer and step runner saw.
      let headValidatedAgainst: string;
      try {
        headValidatedAgainst = await resolveHead(worktreePath, spawnEnv);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return terminate(
          deps,
          runId,
          'infra_error',
          'container_unavailable',
          `resolveHeadSha (post-rebase snapshot) threw: ${msg}`,
          log,
        );
      }

      trace('rebase', {
        round: loopCount,
        result: 'ok',
        conflictsDispatched: rebaseOutcome.conflictsDispatchedCount ?? 0,
        head: headValidatedAgainst,
      });

      writeFinalizeRebaseResultTimeline(orchestratorTimelineDeps(deps), {
        sessionId,
        runId,
        round: loopCount,
        ok: true,
        conflict: (rebaseOutcome.conflictsDispatchedCount ?? 0) > 0,
        headSha: headValidatedAgainst,
      });

      // ── No-progress guard (§6) ──────────────────────────────────────
      // If we re-entered the loop after a fix dispatch but the post-rebase
      // HEAD did not advance, the fixer landed no new commit on the
      // feature branch. Re-running review + checks would reproduce the
      // identical failure every round until the backstop / budget trips.
      // Fail fast with a dedicated, non-retryable reason that names the
      // branch so the operator can see the fixer committed to the wrong
      // branch (or not at all).
      if (prevValidatedHead !== null && headValidatedAgainst === prevValidatedHead) {
        trace('terminal', {
          result: 'fix_no_progress',
          round: loopCount,
          head: headValidatedAgainst,
        });
        return terminate(
          deps,
          runId,
          'failed',
          'fix_no_progress',
          `fix dispatch ended without advancing HEAD on '${opts.branch}' ` +
            `(still ${headValidatedAgainst}) — re-running checks would reproduce ` +
            `the same result. The fixer may have committed to a different branch ` +
            `or made no commit.`,
          log,
        );
      }
      prevValidatedHead = headValidatedAgainst;

      if (opts.signal?.aborted) {
        return cancelTerminal(deps, runId, log);
      }

      // ── Phase 2: parse ci.yaml ──────────────────────────────────────
      // Always re-parse — the session may have edited ci.yaml during the
      // fix dispatch and the loop invariant demands we re-validate it.
      let parseResult: CiConfigParseResult;
      try {
        parseResult = await loadCi(ciConfigPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return terminate(
          deps,
          runId,
          'failed',
          'ci_config_invalid',
          `ci.yaml load threw: ${msg}`,
          log,
        );
      }
      if (!parseResult.ok) {
        return terminate(
          deps,
          runId,
          'failed',
          'ci_config_invalid',
          `${parseResult.error.code}: ${parseResult.error.message}`,
          log,
        );
      }
      parsedCi = parseResult.config;
      // §13: ci.yaml's `timeout_minutes` may LOWER the cap but never
      // raise it. The hard ceiling is FINALIZE_BUDGET_HARD_CEILING_SECONDS
      // — resolveBudgetSeconds clamps to it. We also re-clamp against the
      // current `budgetSeconds` so a dep-injected lower-than-default cap
      // (used in tests) is not silently raised back to 60 by a permissive
      // ci.yaml. Effectively: the narrowest of {dep, ci.yaml, hard cap}
      // wins.
      budgetSeconds = Math.min(
        budgetSeconds,
        resolveBudgetSeconds({ ciTimeoutMinutes: parsedCi.timeoutMinutes }),
      );

      trace('ci_parsed', {
        round: loopCount,
        ciVersion: parsedCi.version,
        timeoutMinutes: parsedCi.timeoutMinutes ?? null,
        budgetSeconds,
      });

      if (opts.signal?.aborted) {
        return cancelTerminal(deps, runId, log);
      }

      // ── Phase 3: reviewer ──────────────────────────────────────────
      // Skipped entirely in `checks` mode ("Run Tests" button): we
      // synthesize an `approved` verdict so the combined gate is driven
      // by the checks phase alone. `reviewRequired` is false only for
      // `mode === 'checks'`.
      if (reviewRequired) {
        try {
          lastReviewerOutcome = await runReview(
            {
              stmts: deps.stmts,
              broadcast: deps.broadcast,
              runReviewer: deps.runReviewer,
              transactional: deps.transactional ?? identityTransactional,
            },
            {
              runId,
              worktreePath,
              baseBranch: opts.baseBranch,
              env: spawnEnv,
              card: opts.card,
              project: opts.project,
              // Plumb the originating session id + cancel signal into the
              // reviewer driver. The in-session reviewer driver attaches
              // the reviewer agent to this session and surfaces its turn
              // in the chat timeline (§10 — session is the canonical log).
              // Cancel race: if the user cancels while the reviewer turn
              // is in flight, the signal kills the CLI BEFORE the
              // tail-parse step, so the run terminal beats the verdict
              // persistence.
              sessionId,
              signal: opts.signal,
            },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return terminate(
            deps,
            runId,
            'failed',
            'review_failed',
            `reviewer dispatch threw: ${msg}`,
            log,
          );
        }
        // Emit active-seconds tick after review (success or fail).
        broadcastActiveSeconds(deps, runId);
        if (lastReviewerOutcome.kind === 'failed') {
          trace('reviewer', {
            round: loopCount,
            result: 'failed',
            failureReason: lastReviewerOutcome.failureReason,
          });
          return outcomeFromFailed(
            deps,
            runId,
            lastReviewerOutcome.failureReason,
            lastReviewerOutcome.detail,
          );
        }
        trace('reviewer', {
          round: loopCount,
          result: 'verdict',
          verdict: lastReviewerOutcome.verdict,
          threads: lastReviewerOutcome.threadCount,
        });
        // Mirror the verdict onto the card. Fires on EVERY loop iteration,
        // not just the first — the user wants to see the back-and-forth when
        // a `changes_requested` verdict triggers a fix dispatch and the next
        // pass produces a new verdict.
        lifecycle.onReviewerVerdict({ runId, verdict: lastReviewerOutcome.verdict });
        // §14 metric: every reviewer verdict, labelled with the 1-indexed
        // attempt the verdict landed on (`loopCount`). A run that bounces
        // between `changes_requested` and `approved` over multiple
        // iterations contributes one row per verdict, not one row total.
        recordReviewerVerdict(
          { stmts: deps.stmts, now, log },
          {
            projectId: opts.project.id,
            runId,
            verdict: lastReviewerOutcome.verdict,
            attemptIndex: loopCount,
          },
        );
      } else {
        // `checks` mode: no reviewer ran. Treat as approved so the
        // combined gate folds to "checks-green only".
        lastReviewerOutcome = {
          kind: 'success',
          verdict: 'approved',
          threadCount: 0,
          activeSecondsBilled: 0,
        };
        trace('reviewer', { round: loopCount, result: 'skipped', verdict: 'approved' });
      }

      if (opts.signal?.aborted) {
        return cancelTerminal(deps, runId, log);
      }

      const reviewerChangesRequested =
        lastReviewerOutcome.kind === 'success' &&
        lastReviewerOutcome.verdict === 'changes_requested';

      // When the reviewer requests changes, dispatch fixes first — do not
      // burn CI budget on code that is already known not mergeable. CI runs
      // only after a subsequent review pass returns `approved`.
      //
      // `review` mode ("Reviewer" button) never runs the tasks phase:
      // `checksRequired` is false, so an approved review synthesizes a
      // green step outcome (below) and the combined gate folds to
      // "review-only".
      if (!reviewerChangesRequested && checksRequired) {
        // Flip to tasks/running before the (potentially long) step phase so
        // the client shows "running checks" immediately after review completes.
        setPhase(deps, runId, sessionId, 'tasks', 'running', log);

        // ── Phase 4: tasks ──────────────────────────────────────────────
        try {
          if (parsedCi.version === 2) {
            // Tenant identity for the remote runner queue (local backend ignores
            // it). getActiveOrgId throws before an org is selected — default to
            // '' so the local path / tests are unaffected.
            let orgId = '';
            try {
              orgId = getActiveOrgId();
            } catch {
              /* no active org — fine for the local backend */
            }
            lastStepOutcome = await runJobs(
              {
                stmts: deps.stmts,
                broadcast: deps.broadcast,
                logStore: deps.logStore,
              },
              {
                runId,
                config: parsedCi,
                worktreePath,
                sessionId,
                branch: opts.branch,
                headSha: headValidatedAgainst,
                env: spawnEnv,
                orgId,
                projectId: opts.project.id,
              },
            );
          } else {
            lastStepOutcome = await runSteps(
              {
                stmts: deps.stmts,
                broadcast: deps.broadcast,
                logStore: deps.logStore,
              },
              {
                runId,
                config: parsedCi,
                worktreePath,
                sessionId,
                env: spawnEnv,
              },
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return terminate(
            deps,
            runId,
            'infra_error',
            'container_unavailable',
            `step phase threw: ${msg}`,
            log,
          );
        }

        // Emit active-seconds tick after the tasks phase (success or fail).
        broadcastActiveSeconds(deps, runId);
        // §14 metric: one row per CI step the runner actually executed.
        // Labels include exit_code so a flaky step's exit-code distribution
        // surfaces directly without re-derivation. `failedStep` carries the
        // first failure; every result before it is a `passed` row.
        {
          const metricDeps = { stmts: deps.stmts, now, log };
          for (const result of lastStepOutcome.stepResults) {
            const failed =
              lastStepOutcome.failedStep != null &&
              lastStepOutcome.failedStep.index === result.index;
            recordStepResult(metricDeps, {
              projectId: opts.project.id,
              runId,
              stepName: result.name,
              status: failed ? 'failed' : 'passed',
              exitCode: result.exitCode,
            });
          }
        }
        trace('checks', {
          round: loopCount,
          engine: parsedCi.version === 2 ? 'jobs' : 'steps',
          status: lastStepOutcome.status,
          steps: lastStepOutcome.stepResults.length,
          failedStep: lastStepOutcome.failedStep?.name ?? null,
          exitCode: lastStepOutcome.failedStep?.exitCode ?? null,
        });
        // Snapshot this round's per-job state into the retry-history table so
        // the flake-recovery classifier can later see "failed round N, passed
        // round M". finalize_run_jobs only keeps the latest state per instance;
        // this append is what makes per-round history durable. v2 jobs only —
        // v1 sequential steps have no job concept to track.
        if (parsedCi.version === 2) {
          ranV2Jobs = true;
          const persisted = recordJobAttemptsForRound(
            { stmts: deps.stmts, now, log },
            { runId, round: loopCount, headSha: headValidatedAgainst },
          );
          if (!persisted) attemptHistoryPersisted = false;
          // Refresh this run's cross-run flake-history rows from the snapshot
          // just recorded. Idempotent upsert per instance — the final round's
          // call reflects the run's ultimate per-instance outcome regardless of
          // terminal path. Best-effort: a miss only degrades future flake-rate
          // accuracy, never the gate's fail-closed correctness.
          recordRunTestHistory(
            { stmts: deps.stmts, now, log },
            {
              runId,
              projectId: opts.project.id,
              branch: opts.branch,
              headSha: headValidatedAgainst,
            },
          );
        }
        // Step terminal classes: the runner already wrote `failed` /
        // `timed_out` to the row for those classes, but NOT for `infra_error`
        // (§10 leaves that to the orchestrator).
        if (lastStepOutcome.status === 'timeout') {
          // §13: surface with the timeout-class dispatch message.
          postBudgetTimeoutMessageIfPossible(
            deps,
            runId,
            opts,
            sessionId,
            budgetSeconds,
            lastStepOutcome,
            log,
          );
          return outcomeFromFailed(deps, runId, 'timeout', `step phase timed out`);
        }
        if (lastStepOutcome.status === 'infra_error') {
          return terminate(
            deps,
            runId,
            'infra_error',
            'container_unavailable',
            lastStepOutcome.infraErrorDetail ?? 'step phase reported infra_error',
            log,
          );
        }
      } else if (!reviewerChangesRequested && !checksRequired) {
        // `review` mode, reviewer approved: no checks phase ran.
        // Synthesize a green step outcome so the combined gate is driven
        // by the reviewer verdict alone.
        lastStepOutcome = {
          status: 'success',
          stepResults: [],
          activeSecondsBilled: 0,
        };
        trace('checks', { round: loopCount, status: 'skipped' });
      } else {
        // Reviewer requested changes — skip CI; fix dispatch comes next.
        lastStepOutcome = null;
        trace('checks', { round: loopCount, status: 'skipped_changes_requested' });
      }

      // A Stop pressed while the CI/runner phase was in flight lands here: the
      // runner does not yet honor the signal, so it runs to completion before
      // returning. Bail before the push gate so a cancelled run can never be
      // clobbered back to ready_to_push and auto-push never fires.
      if (opts.signal?.aborted) {
        return cancelTerminal(deps, runId, log);
      }

      // ── Phase 5 + 7: combined gate (§3) + push gate (§9) ─────────────
      // The combined gate and the push gate fold together: we only
      // re-resolve HEAD when steps + reviewer agree, because the head-sha
      // check is the most expensive of the three (one extra git call) and
      // is meaningless when the first two conditions already refused.
      // When either of the first two fails we drop straight into fix
      // dispatch with the iteration's stale signals — that's the §6
      // behavior the loop invariant guarantees is safe.
      const stepsGreen = lastStepOutcome?.status === 'success';
      const reviewerApproved = lastReviewerOutcome.verdict === 'approved';
      trace('combined_gate', {
        round: loopCount,
        stepsGreen,
        reviewerApproved,
        decision: stepsGreen && reviewerApproved ? 'push_gate' : 'fix_dispatch',
      });
      if (stepsGreen && reviewerApproved) {
        const stepOutcome = lastStepOutcome!;
        // ── Phase 7: push gate (§9) ─────────────────────────────────
        // Refusal here is a TOCTOU outcome: HEAD moved BETWEEN the
        // post-rebase snapshot (`headValidatedAgainst`) and right now —
        // i.e. a commit landed on the feature branch while the reviewer +
        // step phases were running. Comparing against the trigger-time
        // `opts.headSha` would refuse forever after any fix dispatch
        // landed new commits; the snapshot is what review and steps
        // actually validated, so it is the authoritative baseline.
        let currentHead: string;
        try {
          currentHead = await resolveHead(worktreePath, spawnEnv);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return terminate(
            deps,
            runId,
            'infra_error',
            'container_unavailable',
            `resolveHeadSha (push gate) threw: ${msg}`,
            log,
          );
        }
        const gateOutcome = evaluatePushGate({
          stepStatus: stepOutcome.status,
          reviewerVerdict: lastReviewerOutcome.verdict,
          headBeforePhases: headValidatedAgainst,
          headAtPushGate: currentHead,
        });
        if (gateOutcome.kind === 'refuse') {
          trace('push_gate', {
            round: loopCount,
            decision: 'refuse',
            refusalCode: gateOutcome.refusalCode,
            headBeforePhases: headValidatedAgainst,
            headAtPushGate: currentHead,
          });
          // The only refusal reachable in this branch is `head_sha_moved`
          // (the other two refusal codes are unreachable because we
          // already checked `stepsGreen && reviewerApproved`). Re-enter
          // the loop instead of dispatching — there is no failure to
          // dispatch; we just need to re-validate against the new head.
          // The next loop iteration's rebase pass will refresh the
          // snapshot and re-run review + steps.
          log(
            `[finalize-orchestrator] push gate refused for run=${runId}: ` +
              `${gateOutcome.detail}; re-entering rebase`,
          );
          // We do not bill active-seconds here — the gate is a pure check.
          // The next loop iteration will burn the rebase + review + tasks
          // budget for the new head.
          continue;
        }

        trace('push_gate', {
          round: loopCount,
          decision: 'pass',
          validatedHead: gateOutcome.validatedHeadSha,
        });

        // ── Flake-recovery gate (§ retry-until-green) ───────────────
        // Classify the run's per-job retry history: a job that failed an
        // earlier round and passed a later one with no fixer commit touching
        // its code paths laundered a flake into green. Reruns should DETECT
        // flakes, not erase them.
        //
        // FAIL CLOSED: the gate's whole purpose is to stop a flake from being
        // auto-merged, so anything short of a proven-clean classification —
        // missing/failed per-round history, a failed history query, or a failed
        // persist of the verdict — must withhold automation. A blocked or
        // flake-recovered run still parks at ready_to_push so a human can push
        // manually (the explicit acknowledgement); only the AUTOMATED
        // push/merge is withheld.
        //
        // ORDERING IS LOAD-BEARING: the durable `finalize_runs.flake_recovered_jobs`
        // column is what the in-process hook AND the separate automation-runner
        // (which re-reads the row on session-end) both key off. We therefore
        // classify and persist the verdict BEFORE marking the run
        // `ready_to_push`. A run that is never `ready_to_push` is never
        // auto-pushed, so if we cannot durably record a NON-clean gate we fail
        // closed by terminating instead of parking an auto-pushable row whose
        // column reads NULL-and-clean.
        let gate: FlakeGateResult;
        try {
          gate = await classifyRunFlakeRecovery(
            { stmts: deps.stmts, log },
            {
              runId,
              worktreePath,
              env: spawnEnv,
              config: parsedCi,
              expectAttempts: ranV2Jobs,
              attemptsPersisted: attemptHistoryPersisted,
            },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`[finalize-orchestrator] flake-recovery classification threw run=${runId}: ${msg}`);
          gate = blockedGateResult(`flake classification threw: ${msg}`);
        }
        // ── Quarantine lane (§ replace silent retry) ────────────────
        // Excuse flake_recovered instances that are under an active quarantine:
        // they still ran (their result was recorded for monitoring above), but a
        // quarantined flake no longer blocks the gate. If every flagged instance
        // is quarantined, the gate downgrades to clean and automation proceeds —
        // this is what replaces the old "a laundered flake always withholds
        // automation" behaviour. A `blocked` gate is never downgraded (it has no
        // per-instance verdict to excuse), so the fail-closed contract holds.
        const quarantineEntries = loadActiveQuarantine({ stmts: deps.stmts, log }, opts.project.id);
        const quarantined = applyQuarantineToGate(gate, quarantineEntries, now());
        if (quarantined.excused.length > 0) {
          gate = quarantined.gate;
          trace('quarantine_excused', {
            round: loopCount,
            status: gate.status,
            excused: quarantined.excused.map((v) => ({ jobId: v.jobId, matrixKey: v.matrixKey })),
          });
          log(
            `[finalize-orchestrator] run=${runId} quarantine excused flake-recovered job(s): ` +
              `${describeExcused(quarantined.excused)}; gate now status=${gate.status}`,
          );
        }
        let gatePersisted = false;
        try {
          deps.stmts.setFinalizeRunFlakeRecoveredJobs.run(serializeFlakeGate(gate), runId);
          gatePersisted = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`[finalize-orchestrator] failed to persist flake gate state run=${runId}: ${msg}`);
        }
        // A non-clean gate that we could NOT durably record must not become an
        // auto-pushable row: a later automation pass reading the NULL column
        // would treat it as clean and auto-push the very flake we detected.
        // Fail closed by terminating before ready_to_push. (A clean gate
        // serializes to NULL — identical to the column's pre-write value — so a
        // failed write there is a harmless no-op and we proceed.)
        if (!gatePersisted && gate.status !== 'clean') {
          return terminate(
            deps,
            runId,
            'infra_error',
            'container_unavailable',
            `could not persist non-clean flake gate (status=${gate.status}); failing closed to ` +
              `prevent auto-push of an unverified run`,
            log,
          );
        }
        const flakeRecovered = gate.jobs;
        const gateBlocksAutomation = gate.status !== 'clean';
        if (gateBlocksAutomation) {
          trace('flake_gate', {
            round: loopCount,
            status: gate.status,
            reason: gate.reason ?? null,
            jobs: flakeRecovered.map((v) => ({
              jobId: v.jobId,
              matrixKey: v.matrixKey,
              failureCount: v.failureCount,
            })),
          });
        }

        // ── Phase 8: park for human push ────────────────────────────
        // Review + checks passed. Stop before git push / gh pr create —
        // the operator confirms via POST .../finalize/:runId/push. The flake
        // gate verdict is already durably persisted above, so the moment this
        // row becomes `ready_to_push` its automation-gate column is consistent.
        // Final cancel checkpoint before the row goes terminal-success. A Stop
        // landing in the gate-evaluation window above is honored here.
        if (opts.signal?.aborted) {
          return cancelTerminal(deps, runId, log);
        }
        try {
          const info = deps.stmts.markFinalizeRunReadyToPush.run(
            gateOutcome.validatedHeadSha,
            runId,
          );
          // The guarded UPDATE (`status != 'cancelled'`) refuses to resurrect a
          // row the cancel endpoint flipped in the race window after the check
          // above. `changes === 0` means the row is gone or already cancelled —
          // do not announce ready_to_push or fire the auto-push hook.
          if (info && typeof info.changes === 'number' && info.changes === 0) {
            return cancelTerminal(deps, runId, log);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return terminate(
            deps,
            runId,
            'infra_error',
            'container_unavailable',
            `markFinalizeRunReadyToPush failed: ${msg}`,
            log,
          );
        }

        // A run only announces "ready to push to GitHub" once the branch is
        // FULLY validated — both the reviewer AND the CI checks passed on the
        // same commit. A `full` run does that in one pass. A manual
        // checks-only ("Run Tests") or review-only ("Reviewer") run validates
        // a single phase; it must NOT claim ready-to-push until its sibling
        // phase has also passed for the same head (e.g. the operator then
        // runs the other button). The split-button UI surfaces the per-phase
        // done-state ("Tested" / "Reviewed") in the meantime. `validated` is
        // threaded onto the broadcast so live consumers (the sidebar
        // "ready to push" indicator) can distinguish a real full validation
        // from a single-phase park.
        const fullyValidated = isBranchFullyValidated(
          deps,
          sessionId,
          mode,
          gateOutcome.validatedHeadSha,
          runId,
        );
        trace('ready_to_push', {
          round: loopCount,
          fullyValidated,
          head: gateOutcome.validatedHeadSha,
        });
        deps.broadcast({
          type: 'finalize_run_phase_changed',
          run_id: runId,
          session_id: sessionId,
          phase: null,
          status: 'ready_to_push',
          validated: fullyValidated,
        });
        deps.broadcast({
          type: 'finalize_run_completed',
          run_id: runId,
          session_id: sessionId,
          status: 'ready_to_push',
          validated: fullyValidated,
        });
        if (flakeRecovered.length > 0) {
          writeFinalizeFlakeRecoveredTimeline(orchestratorTimelineDeps(deps), {
            sessionId,
            runId,
            round: loopCount,
            jobs: flakeRecovered.map((v) => ({
              jobId: v.jobId,
              matrixKey: v.matrixKey,
              failureCount: v.failureCount,
              failedRounds: v.failedRounds,
              passedRound: v.passedRound,
            })),
          });
        }
        if (fullyValidated) {
          lifecycle.onReadyToPush({ runId });
          writeFinalizeReadyToPushTimeline(orchestratorTimelineDeps(deps), {
            sessionId,
            runId,
            validatedHeadSha: gateOutcome.validatedHeadSha,
            round: loopCount,
            host: opts.project.gitHost === 'agenthub' ? 'agenthub' : 'github',
          });
          // Push/merge automation only fires on full validation — auto-pushing
          // a single-phase run would ship code that skipped the other gate. The
          // flake gate withholds automation for BOTH a flake-recovered run (a
          // rerun laundered an earlier failure into green) and a `blocked` run
          // (the gate could not prove the run is clean). Either way a human must
          // push manually to acknowledge.
          if (gateBlocksAutomation) {
            log(
              `[finalize-orchestrator] run=${runId} reached ready_to_push but flake gate ` +
                `status=${gate.status}` +
                (gate.reason ? ` (${gate.reason})` : '') +
                (flakeRecovered.length > 0 ? ` [${flakeRecovered.length} job(s)]` : '') +
                `; withholding push automation — human acknowledgement (manual push) required`,
            );
          } else {
            notifyReadyToPushAutomationHook(sessionId, runId);
          }
        } else {
          log(
            `[finalize-orchestrator] run=${runId} mode=${mode} passed its phase ` +
              `(head=${gateOutcome.validatedHeadSha}); awaiting sibling phase before ready-to-push`,
          );
        }
        return { kind: 'ready_to_push', runId };
      }

      // ── Phase 6: fix dispatch ───────────────────────────────────────
      // Either steps failed, reviewer requested changes, or both. Build
      // the §7 trigger and inject the message; await turn-end and re-enter
      // the loop. The watchdog is armed inside `dispatchFixMessage` for
      // `ui_button` triggers only.
      const trigger = buildFixTrigger(deps, runId, lastStepOutcome, lastReviewerOutcome, log, {
        reviewRequired,
        checksRequired,
      });
      // Mirror a step failure onto the card — exactly when there IS a
      // failed step AND the fix-dispatch loop is about to run. Reviewer-
      // only `changes_requested` cases (no failed step) are already
      // covered by `onReviewerVerdict` above; we deliberately don't
      // double-comment.
      if (lastStepOutcome?.failedStep) {
        lifecycle.onStepFailed({
          runId,
          stepName: lastStepOutcome.failedStep.name,
          exitCode: lastStepOutcome.failedStep.exitCode,
        });
      }
      if (isTriggerEmpty(trigger)) {
        // Defensive: combined gate said "not green AND approved" but the
        // composer found nothing useful (both step success and reviewer
        // approved with empty threads). The only way this can happen is a
        // bug in upstream logic; surface as failed with a dedicated code so
        // it can't be confused with `review_failed` (real reviewer crash)
        // or `max_fix_iterations` (runaway-loop backstop).
        return terminate(
          deps,
          runId,
          'failed',
          'combined_gate_invariant_violated',
          'combined gate refused but no failure signal to dispatch',
          log,
        );
      }

      trace('fix_dispatch', {
        round: loopCount,
        phase: 'dispatching',
        failedStep: trigger.failedStep?.name ?? null,
        reviewerVerdict: trigger.reviewerVerdict ?? null,
        reviewerThreads: trigger.reviewerThreads?.length ?? 0,
      });

      // §14: count every fix dispatch the family produces. Incremented
      // BEFORE the await so cancellation / errors mid-dispatch still
      // contribute (the work was started, even if it didn't finish).
      fixDispatchCounter.value += 1;
      let fix: FixDispatchResult;
      try {
        fix = await dispatchFix(
          {
            stmts: deps.stmts,
            broadcast: deps.broadcast,
            turnEnd: deps.turnEnd,
            spawnFixTurn: deps.spawnFixTurn,
          },
          {
            runId,
            sessionId,
            projectId: opts.project.id,
            cardId: opts.card.id,
            triggerSource: opts.triggerSource,
            cardTitle: opts.card.title,
            trigger,
            notifyAfterMs: opts.stallNotifyAfterMs,
            stallAfterMs: opts.stallAfterMs,
            signal: opts.signal,
          },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return terminate(
          deps,
          runId,
          'infra_error',
          'container_unavailable',
          `fix dispatch threw: ${msg}`,
          log,
        );
      }

      // Emit active-seconds tick after fix dispatch. The fix-dispatch
      // helper itself bills the per-dispatch entry charge; the chat.ts
      // session turn-end hook bills the originating-session turn
      // duration. Both writes have already landed by the time we're here;
      // this broadcast surfaces the combined running total.
      broadcastActiveSeconds(deps, runId);
      trace('fix_dispatch', { round: loopCount, phase: 'settled', outcome: fix.outcome });
      if (fix.outcome === 'stalled_no_response') {
        // The watchdog already wrote the terminal status; just surface.
        // Mirror the stall onto the card — this is the "human walked away"
        // branch (see card `490d6c41`); the comment names the two recovery
        // actions so the user has a clear next step.
        lifecycle.onStalled({ runId });
        // §14 metric: per-CEO-requested 24-hour terminal counter. Fires
        // once per stall so dashboards can spot whether the dogfood
        // window is producing more abandoned runs than expected.
        recordStalledNoResponse(
          { stmts: deps.stmts, now, log },
          { projectId: opts.project.id, runId },
        );
        return { kind: 'stalled', runId };
      }
      if (fix.outcome === 'cancelled') {
        return cancelTerminal(deps, runId, log);
      }
      if (fix.outcome === 'spawn_failed') {
        return terminate(
          deps,
          runId,
          'failed',
          'dispatch_failure',
          'agent CLI spawn failed during fix dispatch',
          log,
        );
      }
      // `turn_ended` — the session committed (or at least ended its turn).
      // We re-enter at the top of the loop. The next iteration's rebase
      // pass will refresh the worktree state and the reviewer + step
      // verdicts will be reproduced against the new HEAD.
    }

    trace('terminal', { result: 'max_fix_iterations', loops: MAX_FIX_DISPATCH_LOOPS });
    return terminate(
      deps,
      runId,
      'failed',
      // Distinct code from `review_failed` (the reviewer step itself
      // crashing) so dashboards / log queries can tell apart "the LLM
      // reviewer broke" from "the runaway-loop backstop tripped". The
      // backstop should almost never fire — when it does, that's the
      // signal that either the active-time budget is misconfigured or
      // the fix dispatch produced no actual commits across N iterations.
      'max_fix_iterations',
      `fix-dispatch loop hit MAX_FIX_DISPATCH_LOOPS=${MAX_FIX_DISPATCH_LOOPS}`,
      log,
    );
  }; // end driveAttempt

  // ─── §10: drive original attempt + generation-aware infra-retry chain ─
  // The first attempt receives the trigger-time session/worktree (which
  // may be null when the card has no live session — in that case the
  // attempt's session-resolution block spawns one and persists the
  // resolved values onto the row). Each retry attempt inherits whatever
  // the previous one resolved, so spawnSession is NOT re-fired on the
  // retry path.
  //
  // Generation-aware infra-retry chain. Each infra-class terminal may open
  // ONE more retry generation, up to the per-class cap enforced inside
  // `openInfraRetryRun` (generic infra survives one extra reclaim; a known
  // `spot_reclaimed` survives more). This replaces the historical hardcoded
  // single retry so a run that loses its driving agent to BACK-TO-BACK Spot
  // reclaims still recovers instead of terminating green code as infra_error.
  //
  // The metrics `isFamilyTerminal` flag is true only for the attempt that does
  // NOT spawn a further retry — that attempt carries the single
  // `finalize_fix_dispatch_count` sample (§14).
  let currentRunId = runId;
  let currentRetryOf: string | null = opts.retryOfRunId ?? null;
  let attemptSessionId: string | null = opts.sessionId ?? opts.card.session_id ?? null;
  let attemptWorktreePath: string | null = opts.worktreePath ?? null;
  let attempt = await driveAttempt(
    currentRunId,
    currentRetryOf,
    attemptSessionId,
    attemptWorktreePath,
  );

  // Hard backstop on the chain length. `openInfraRetryRun` already enforces a
  // finite per-class generation cap, so under normal operation the natural
  // `!retry` exit below fires first. This bound is pure defense against a
  // cyclic `retry_of_run_id` chain or a cap-logic bug — and it is DERIVED from
  // the live caps (+1) rather than a fixed constant, so an intentionally-raised
  // env cap is never silently truncated below what the operator configured.
  //
  // Crucially, when the backstop is reached we DO NOT just break: we stop
  // opening retries so the current attempt falls through the terminal path
  // below. That guarantees the last-driven attempt always gets its terminal
  // metrics + infra message — the previous fixed-bound loop could open and
  // drive a final retry, then exit the loop without finalizing it.
  const chainBackstop =
    Math.max(
      resolveRetryGenerationCap('container_unavailable'),
      resolveRetryGenerationCap('spot_reclaimed'),
    ) + 1;
  for (let i = 0; ; i++) {
    const isInfraTerminal =
      attempt.kind === 'failed' &&
      attempt.status === 'infra_error' &&
      isInfraFailureReason(attempt.failureReason);

    // Only an infra-class terminal under the hard backstop is eligible for
    // another generation. `openInfraRetryRun` enforces the per-class generation
    // cap (and refuses on a missing parent / raced insert), returning null when
    // no retry should run — in which case this attempt is the family terminal.
    const retry =
      i < chainBackstop && isInfraTerminal && attempt.kind === 'failed'
        ? openInfraRetryRun(
            { stmts: deps.stmts, broadcast: deps.broadcast, newId, now, log },
            {
              parentRunId: currentRunId,
              triggerSource: opts.triggerSource,
              parentFailureReason: attempt.failureReason,
            },
          )
        : null;

    // §14 metric: terminal counters + histograms. Family-terminal iff no
    // further retry will run.
    writeTerminalMetrics(currentRunId, statusFromOutcome(attempt), /* isFamilyTerminal */ !retry);

    if (!retry) {
      // §10 terminal: an infra failure that exhausted the retry budget
      // surfaces as `infra_error` AND posts a system message into the
      // originating session naming the machine code + escalation hint. No
      // GitHub surfaces touched — Finalize runs entirely pre-PR.
      if (isInfraTerminal && attempt.kind === 'failed') {
        let terminalSessionId: string | null = attemptSessionId;
        try {
          const finalRow = deps.stmts.getFinalizeRun.get(currentRunId) as
            | FinalizeRunRow
            | undefined;
          terminalSessionId = finalRow?.session_id ?? terminalSessionId;
        } catch {
          /* fall back to attemptSessionId */
        }
        postInfraTerminalMessage(
          { stmts: deps.stmts, broadcast: deps.broadcast, log, newId },
          {
            parentRunId: currentRetryOf ?? currentRunId,
            retryRunId: currentRunId,
            sessionId: terminalSessionId,
            cardId: opts.card.id,
            projectId: opts.project.id,
            failureReason: attempt.failureReason,
            detail: attempt.detail,
          },
        );
      }
      return attempt;
    }

    // A retry opened. Inherit whatever the parent resolved mid-attempt
    // (session_id / worktree_path) so spawnSession does NOT re-fire — the
    // session owns the worktree per §6.
    let inheritSessionId: string | null = attemptSessionId;
    let inheritWorktreePath: string | null = attemptWorktreePath;
    try {
      const parentRow = deps.stmts.getFinalizeRun.get(currentRunId) as FinalizeRunRow | undefined;
      inheritSessionId = parentRow?.session_id ?? inheritSessionId;
      inheritWorktreePath = parentRow?.worktree_path ?? inheritWorktreePath;
    } catch (err) {
      log(
        `[finalize-orchestrator] reading parent row=${currentRunId} for retry inheritance threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // §14 metric: the retry is a NEW finalize_runs row — record its start so
    // `count(finalize_run_started)` matches `count(finalize_run_completed)`.
    recordRunStarted(
      { stmts: deps.stmts, now, log },
      { projectId: opts.project.id, runId: retry.runId, triggerSource: opts.triggerSource },
    );

    currentRetryOf = currentRunId;
    currentRunId = retry.runId;
    attemptSessionId = inheritSessionId;
    attemptWorktreePath = inheritWorktreePath;
    attempt = await driveAttempt(
      currentRunId,
      currentRetryOf,
      attemptSessionId,
      attemptWorktreePath,
    );
  }
  // Unreachable: the `for (;;)` loop only exits via the `return attempt` in the
  // terminal (`!retry`) branch, which the backstop guarantees is always taken.
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * §3 decision-trace gate. Defaults ON so the implementation→test→review→push
 * path is reconstructable from logs out of the box; the run is infrequent
 * (human- or kanban-triggered) so the ~12-line-per-run volume is cheap.
 * `FINALIZE_TRACE=off` (also `0` / `false`) silences it for a deploy that
 * wants quieter logs.
 */
function finalizeTraceEnabled(): boolean {
  const raw = process.env.FINALIZE_TRACE?.trim().toLowerCase();
  return raw !== 'off' && raw !== '0' && raw !== 'false';
}

/**
 * Render a decision record as a single space-delimited `key=value` line.
 * `undefined` / `null` fields are dropped so optional signals don't render
 * as noise.
 *
 * Value encoding keeps the line unambiguously parseable from PM2 logs while
 * staying greppable for the common case:
 *   - A "simple" string (no whitespace, quote, `=`, or backslash — e.g. a
 *     sha, verdict, or single-token name) passes through verbatim.
 *   - Any other string is JSON-encoded, so a value with spaces or newlines
 *     (`failedStep`, `failureReason`, a job/filter name) becomes a quoted,
 *     escaped token rather than spilling into the next field. Without this a
 *     line like `failedStep=npm run test decision=fix_dispatch` would parse
 *     as three bogus fields.
 *   - Non-strings (booleans / numbers / arrays) are JSON-encoded so they're
 *     type-unambiguous.
 */
function formatTraceFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeTraceValue(v)}`)
    .join(' ');
}

/** A string token safe to emit bare in a `key=value` trace line. */
const SAFE_TRACE_TOKEN = /^[^\s"=\\]+$/;

function encodeTraceValue(value: unknown): string {
  if (typeof value === 'string') {
    return SAFE_TRACE_TOKEN.test(value) ? value : JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function orchestratorTimelineDeps(deps: OrchestratorDeps): TimelineMessageDeps {
  return { stmts: deps.stmts, broadcast: deps.broadcast, log: undefined };
}

function setPhase(
  deps: OrchestratorDeps,
  runId: string,
  sessionId: string | null,
  phase: FinalizeRunPhase,
  status: FinalizeRunStatus,
  log: (msg: string) => void,
): void {
  try {
    deps.stmts.updateFinalizeRunPhase.run(phase, status, runId);
  } catch (err) {
    log(
      `[finalize-orchestrator] phase write failed for run=${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  deps.broadcast({
    type: 'finalize_run_phase_changed',
    run_id: runId,
    ...(sessionId ? { session_id: sessionId } : {}),
    phase,
    status,
  });
}

function terminate(
  deps: OrchestratorDeps,
  runId: string,
  status: FinalizeRunStatus,
  failureReason: string,
  detail: string,
  log: (msg: string) => void,
): OrchestratorOutcome {
  try {
    deps.stmts.failFinalizeRun.run(status, failureReason, runId);
  } catch (err) {
    log(
      `[finalize-orchestrator] failFinalizeRun failed for run=${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  mirrorTerminalFailureOnCard(deps, runId, status, failureReason, detail);
  const row = deps.stmts.getFinalizeRun.get(runId) as FinalizeRunRow | undefined;
  deps.broadcast({
    type: 'finalize_run_phase_changed',
    run_id: runId,
    ...(row?.session_id ? { session_id: row.session_id } : {}),
    phase: null,
    status,
    failure_reason: failureReason,
  });
  deps.broadcast({
    type: 'finalize_run_completed',
    run_id: runId,
    ...(row?.session_id ? { session_id: row.session_id } : {}),
    status,
    failure_reason: failureReason,
  });
  try {
    writeFinalizeRunTerminalTimeline(orchestratorTimelineDeps(deps), {
      sessionId: row?.session_id,
      runId,
      status,
      failureReason,
      round: readFinalizeLoopRound(row),
    });
  } catch {
    /* best-effort */
  }
  return { kind: 'failed', runId, status, failureReason, detail };
}

function cancelTerminal(
  deps: OrchestratorDeps,
  runId: string,
  log: (msg: string) => void,
): OrchestratorOutcome {
  try {
    deps.stmts.failFinalizeRun.run('cancelled', 'cancelled', runId);
  } catch (err) {
    log(
      `[finalize-orchestrator] failFinalizeRun (cancelled) failed for run=${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const row = deps.stmts.getFinalizeRun.get(runId) as FinalizeRunRow | undefined;
  deps.broadcast({
    type: 'finalize_run_phase_changed',
    run_id: runId,
    ...(row?.session_id ? { session_id: row.session_id } : {}),
    phase: null,
    status: 'cancelled',
    failure_reason: 'cancelled',
  });
  deps.broadcast({
    type: 'finalize_run_completed',
    run_id: runId,
    ...(row?.session_id ? { session_id: row.session_id } : {}),
    status: 'cancelled',
  });
  try {
    writeFinalizeRunTerminalTimeline(orchestratorTimelineDeps(deps), {
      sessionId: row?.session_id,
      runId,
      status: 'cancelled',
      failureReason: 'cancelled',
      round: readFinalizeLoopRound(row),
    });
  } catch {
    /* best-effort */
  }
  return { kind: 'cancelled', runId };
}

/**
 * Read the current `active_seconds_consumed` and return true if it has
 * crossed the budget. The orchestrator does NOT bill active time itself
 * — every phase module bills its own units; this helper only reads back
 * the running total against the cap.
 *
 * §13: the cap is shared across the original run and its one infra
 * retry. We defer to {@link budgetIsExhausted} (from `budget.ts`),
 * which walks `retry_of_run_id` and sums the family total — the retry
 * does NOT get a fresh 60-min budget.
 */
function budgetExhausted(
  deps: OrchestratorDeps,
  runId: string,
  budgetSeconds: number,
  log: (msg: string) => void,
): boolean {
  return budgetIsExhausted(deps.stmts, runId, budgetSeconds, log);
}

/**
 * Terminal-state writer specialized for the §13 budget timeout. Posts
 * a system message into the originating session with the last attempt's
 * output tail (so the human / autonomous agent can see what was
 * happening when the budget ran out) and then drops into the
 * standard {@link terminate} path with `status = 'timed_out'`.
 *
 * Session message is best-effort: a missing `sessionId` (defensive —
 * shouldn't happen at this point in the state machine) or a DB hiccup
 * just skips the message and proceeds with the terminal write.
 */
function timeoutTerminal(
  deps: OrchestratorDeps,
  runId: string,
  opts: OrchestratorOptions,
  sessionId: string | null,
  budgetSeconds: number,
  lastStepOutcome: StepRunResult | null,
  log: (msg: string) => void,
): OrchestratorOutcome {
  postBudgetTimeoutMessageIfPossible(
    deps,
    runId,
    opts,
    sessionId,
    budgetSeconds,
    lastStepOutcome,
    log,
  );
  return terminate(
    deps,
    runId,
    'timed_out',
    'timeout',
    `active-time budget of ${budgetSeconds}s exhausted`,
    log,
  );
}

/**
 * Best-effort: drop a §13 timeout message into the originating
 * session, carrying the last attempt's output tail. The orchestrator
 * calls this from every code path that surfaces a budget timeout
 * (top-of-loop guard, rebase timeout, step-phase timeout) so the
 * dispatched message is consistent regardless of WHERE the budget
 * tripped.
 *
 * The session keeps its worktree on terminal — the session owns the
 * worktree and the orchestrator never touches it on shutdown (§13:
 * "container torn down, worktree state preserved").
 */
function postBudgetTimeoutMessageIfPossible(
  deps: OrchestratorDeps,
  runId: string,
  opts: OrchestratorOptions,
  sessionId: string | null,
  budgetSeconds: number,
  lastStepOutcome: StepRunResult | null,
  log: (msg: string) => void,
): void {
  if (!sessionId) return;
  let activeSecondsConsumed = budgetSeconds;
  try {
    activeSecondsConsumed = getRunFamilyActiveSeconds(deps.stmts, runId);
  } catch {
    /* best-effort */
  }
  try {
    postTimeoutDispatchMessage(
      { stmts: deps.stmts, broadcast: deps.broadcast, log },
      {
        runId,
        sessionId,
        cardId: opts.card.id,
        projectId: opts.project.id,
        budgetSeconds,
        activeSecondsConsumed,
        lastOutputTail: lastStepOutcome?.failedStep?.outputTail,
        lastStepName: lastStepOutcome?.failedStep?.name,
        lastStepExitCode: lastStepOutcome?.failedStep?.exitCode,
      },
    );
  } catch (err) {
    log(
      `[finalize-orchestrator] timeout message post failed for run=${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Map a phase module's failure_reason to a top-level orchestrator
 * outcome AND emit the run-terminal broadcast pair (`finalize_run_phase_changed`
 * + `finalize_run_completed`). Sub-phase modules already wrote the row's
 * terminal status via their own `failFinalizeRun` call — this helper
 * does NOT re-write the DB (avoiding double `ended_at` updates), but it
 * DOES guarantee subscribers see the `finalize_run_completed` event
 * regardless of which phase produced the failure. Without this, clients
 * subscribing only to `finalize_run_completed` (the canonical "this run
 * is over" signal) would silently never hear about rebase / review /
 * step-timeout failures.
 *
 * The status column on `finalize_runs` already reflects whatever the
 * sub-phase set; we mirror it here for the broadcast payload so the UI
 * doesn't need a row re-read to render the terminal state.
 */
function outcomeFromFailed(
  deps: OrchestratorDeps,
  runId: string,
  failureReason: string,
  detail?: string,
): OrchestratorOutcome {
  const status: FinalizeRunStatus =
    failureReason === 'timeout'
      ? 'timed_out'
      : failureReason === 'container_unavailable' ||
          failureReason === 'worktree_create_failed' ||
          failureReason === 'github_push_5xx'
        ? 'infra_error'
        : 'failed';
  mirrorTerminalFailureOnCard(deps, runId, status, failureReason, detail);
  const row = deps.stmts.getFinalizeRun.get(runId) as FinalizeRunRow | undefined;
  // Mirror what `terminate()` emits so subscribers see the same shape on
  // every terminal path, regardless of which phase produced the failure.
  // The sub-phase already wrote the row's terminal status (status,
  // failure_reason, ended_at); we do not re-write here.
  deps.broadcast({
    type: 'finalize_run_phase_changed',
    run_id: runId,
    ...(row?.session_id ? { session_id: row.session_id } : {}),
    phase: null,
    status,
    failure_reason: failureReason,
  });
  deps.broadcast({
    type: 'finalize_run_completed',
    run_id: runId,
    ...(row?.session_id ? { session_id: row.session_id } : {}),
    status,
    failure_reason: failureReason,
  });
  return { kind: 'failed', runId, status, failureReason, detail };
}

/**
 * Post a compact failure comment on the kanban card. Skips statuses that
 * have their own dedicated lifecycle hooks (`onStalled`, `onPushed`) or
 * that are user-initiated (`cancelled`).
 */
function mirrorTerminalFailureOnCard(
  deps: OrchestratorDeps,
  runId: string,
  status: FinalizeRunStatus,
  failureReason: string,
  detail?: string,
): void {
  if (status === 'cancelled' || status === 'stalled_no_response' || status === 'pushed') {
    return;
  }
  const lifecycle = deps.cardLifecycle ?? NOOP_CARD_LIFECYCLE;
  try {
    lifecycle.onTerminalFailed({ runId, status, failureReason, detail });
  } catch {
    // Card comments are cosmetic — never fail the run.
  }
}

/**
 * Whether the branch is FULLY validated (reviewer approved AND CI checks
 * passed against the same commit) as of this run reaching its push gate.
 *
 *   - `full` runs validate both phases in one pass → always true.
 *   - `checks` / `review` runs validate a single phase. They are only fully
 *     validated when the SIBLING phase already passed for the same
 *     `validated_head_sha` (e.g. the operator ran the other split button
 *     with no commits in between). Otherwise the branch has passed one gate
 *     but not the other, so we hold back the "ready to push" announcement.
 *
 * The sibling lookup reuses the per-phase pickers
 * (`getLatestChecksRunForSession` / `getLatestReviewRunForSession`), which
 * each include `full` runs, so a prior full pass also counts as the sibling.
 */
function isBranchFullyValidated(
  deps: OrchestratorDeps,
  sessionId: string | null,
  mode: FinalizeRunMode,
  validatedHeadSha: string,
  currentRunId: string,
): boolean {
  if (mode === 'full') return true;
  if (!sessionId) return false;
  const siblingStmt =
    mode === 'checks'
      ? deps.stmts.getLatestReviewRunForSession
      : deps.stmts.getLatestChecksRunForSession;
  const sibling = siblingStmt.get(sessionId) as FinalizeRunRow | undefined;
  if (!sibling || sibling.id === currentRunId) return false;
  const siblingPassed = sibling.status === 'ready_to_push' || sibling.status === 'pushed';
  return siblingPassed && sibling.validated_head_sha === validatedHeadSha;
}

/**
 * Build the §7 fix-dispatch trigger from the last step + reviewer
 * outcomes. Pulls reviewer threads from the DB so the composer renders
 * the canonical row shape (not the input shape from `runReviewer`).
 */
function buildFixTrigger(
  deps: OrchestratorDeps,
  runId: string,
  stepOutcome: StepRunResult | null,
  reviewerOutcome: ReviewerDispatchOutcome | null,
  log: (msg: string) => void,
  phases: { reviewRequired: boolean; checksRequired: boolean } = {
    reviewRequired: true,
    checksRequired: true,
  },
): FixDispatchTrigger {
  const trigger: FixDispatchTrigger = {};
  // Only surface signals from phases this run actually executed. A
  // `checks`-mode run synthesizes an approved verdict (never ran the
  // reviewer); a `review`-mode run synthesizes a green step outcome
  // (never ran CI). Including a synthesized signal would render a
  // misleading "reviewer approved" / "all checks passed" line in the
  // fix-dispatch message.
  if (phases.checksRequired && stepOutcome?.failedStep) {
    trigger.failedStep = {
      phase: 'tasks',
      name: stepOutcome.failedStep.name,
      exitCode: stepOutcome.failedStep.exitCode,
      outputTail: stepOutcome.failedStep.outputTail,
      ...(stepOutcome.failedStep.failureExcerpt?.length
        ? { failureExcerpt: stepOutcome.failedStep.failureExcerpt }
        : {}),
    };
  }
  if (phases.reviewRequired && reviewerOutcome?.kind === 'success') {
    trigger.reviewerVerdict = reviewerOutcome.verdict;
    try {
      trigger.reviewerThreads = deps.stmts.listReviewerThreadsForRun.all(runId) as never;
    } catch (err) {
      log(
        `[finalize-orchestrator] listReviewerThreadsForRun failed for run=${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      trigger.reviewerThreads = [];
    }
  }
  return trigger;
}

function isTriggerEmpty(trigger: FixDispatchTrigger): boolean {
  if (trigger.failedStep) return false;
  if (trigger.reviewerVerdict === 'changes_requested') return false;
  if (trigger.reviewerThreads && trigger.reviewerThreads.length > 0) return false;
  return true;
}

/**
 * Map an {@link OrchestratorOutcome} to the string the §14 metrics
 * pipeline records for the run's terminal state. `reused` is omitted
 * from metrics — the original row's terminal write already produced the
 * count, and double-counting a reused row would skew the funnel.
 */
function statusFromOutcome(outcome: OrchestratorOutcome): string | undefined {
  switch (outcome.kind) {
    case 'ready_to_push':
      return 'ready_to_push';
    case 'pushed':
      return 'pushed';
    case 'cancelled':
      return 'cancelled';
    case 'stalled':
      return 'stalled_no_response';
    case 'failed':
      return outcome.status;
    case 'reused':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Default head-resolver — `git rev-parse HEAD` on the worktree. Tests
 * inject a deterministic stub.
 */
async function defaultResolveHeadSha(
  worktreePath: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: worktreePath,
    env,
    timeout: 30_000,
    maxBuffer: 1 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Identity transactional wrapper for tests that don't need atomicity.
 * Production callers MUST inject `db.transaction(...)` from
 * `better-sqlite3` — see `reviewer-dispatch.ts` for the contract.
 */
function identityTransactional<T>(fn: () => T): T {
  return fn();
}

export const __test = {
  computeIdempotencyKey,
  finalizeTraceEnabled,
  formatTraceFields,
  buildFixTrigger,
  isTriggerEmpty,
  outcomeFromFailed,
  budgetExhausted,
  timeoutTerminal,
  postBudgetTimeoutMessageIfPossible,
  statusFromOutcome,
  MAX_FIX_DISPATCH_LOOPS,
  DEFAULT_CI_CONFIG_RELATIVE_PATH,
};

// Suppress the unused-import warning for ReviewerLocalDiffInputs — it is
// re-exported here so callers of the orchestrator can construct
// reviewer-driver inputs without importing the sub-module directly.
export type { ReviewerLocalDiffInputs };
