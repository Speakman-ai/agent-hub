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
import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  BroadcastFn,
  FinalizeRunPhase,
  FinalizeRunRow,
  FinalizeRunStatus,
  KanbanCardRow,
  Project,
  Stmts,
} from '../types.js';
import { FINALIZE_BUDGET_SECONDS, runRebasePhase } from './rebase.js';
import type { RebasePhaseOutcome } from './rebase.js';
import { loadCiConfigFromFile } from './ci-config.js';
import type { CiConfig, CiConfigParseResult } from './ci-config.js';
import { runReviewerDispatch } from './reviewer-dispatch.js';
import type {
  ReviewerDispatchOutcome,
  ReviewerLocalDiffInputs,
  RunReviewerOnLocalDiff,
} from './reviewer-dispatch.js';
import { runStepPhase } from './step-runner.js';
import type { StepRunResult } from './step-runner.js';
import { dispatchFixMessage } from './fix-dispatch.js';
import type {
  CancelSignal,
  FixDispatchResult,
  FixDispatchTrigger,
  TurnEndSubscriber,
} from './fix-dispatch.js';
import { writeFinalizeRunPrUrl } from './provenance.js';
import { evaluatePushGate } from './push-gate.js';
import { NOOP_CARD_LIFECYCLE } from './card-lifecycle.js';
import type { CardLifecycle } from './card-lifecycle.js';

const execFileAsync = promisify(execFile);

// ─── Public constants ─────────────────────────────────────────────────

/**
 * Cap on outer fix-dispatch loops. Per §13 the only ceiling is the
 * 60-minute active-time budget; this constant is a runaway-loop backstop
 * so a pathological "session immediately ends its turn without committing"
 * cannot spin forever before the budget catches up. Deliberately generous —
 * a healthy run almost never exceeds 5 loops.
 */
export const MAX_FIX_DISPATCH_LOOPS = 50;

/** Default path of `.agent-hub/ci.yaml` relative to the worktree root. */
export const DEFAULT_CI_CONFIG_RELATIVE_PATH = '.agent-hub/ci.yaml';

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
  stmts: Pick<
    Stmts,
    | 'getFinalizeRun'
    | 'getFinalizeRunByIdempotencyKey'
    | 'insertFinalizeRun'
    | 'updateFinalizeRunPhase'
    | 'updateFinalizeRunActiveSeconds'
    | 'updateFinalizeRunSessionId'
    | 'updateFinalizeRunWorktreePath'
    | 'updateFinalizeRunReviewerVerdict'
    | 'failFinalizeRun'
    | 'markFinalizeRunPushed'
    | 'updateFinalizeRunPrUrl'
    | 'insertReviewerThread'
    | 'deleteReviewerThreadsForRun'
    | 'addMessage'
    | 'touchSession'
    | 'getMessageById'
    | 'listReviewerThreadsForRun'
  >;
  broadcast: BroadcastFn;
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
  dispatchFixMessage?: typeof dispatchFixMessage;
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
 * Compute the idempotency key for a finalize run. SHA-256 over
 * `<project_id>|<branch>|<head_sha>` hex-encoded — matches the design
 * doc's §4 contract and the UNIQUE constraint on `finalize_runs`.
 *
 * Exposed so trigger routes / dispatch paths can pre-compute the key for
 * a uniqueness lookup before they call into the orchestrator.
 */
export function computeIdempotencyKey(args: {
  projectId: string;
  branch: string;
  headSha: string;
}): string {
  return createHash('sha256')
    .update(`${args.projectId}|${args.branch}|${args.headSha}`)
    .digest('hex');
}

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
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const budgetSeconds = deps.budgetSeconds ?? FINALIZE_BUDGET_SECONDS;
  // The kanban-card mirror. Default no-op keeps the existing test deps
  // shape minimal — production injects a real lifecycle bound to
  // (cardId, projectId). See `card-lifecycle.ts`.
  const lifecycle = deps.cardLifecycle ?? NOOP_CARD_LIFECYCLE;
  const runRebase = deps.runRebasePhase ?? runRebasePhase;
  const loadCi = deps.loadCiConfigFromFile ?? loadCiConfigFromFile;
  const runReview = deps.runReviewerDispatch ?? runReviewerDispatch;
  const runSteps = deps.runStepPhase ?? runStepPhase;
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

  // ─── Idempotency: dedup at the (project, branch, head_sha) level ────
  const idempotencyKey = computeIdempotencyKey({
    projectId: opts.project.id,
    branch: opts.branch,
    headSha: opts.headSha,
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
  // Mirror the run's start onto the kanban card: move card → In Progress
  // (idempotent if already there) and post the "Finalize started" comment.
  // Idempotency on re-trigger is handled at the row-insert dedup above —
  // a `'reused'` short-circuit never reaches this point, so we don't
  // double-comment when the user clicks Finalize twice against the same
  // head sha.
  lifecycle.onStarted({ runId, triggerSource: opts.triggerSource });

  // Pre-cancel: caller already aborted before we wired anything up.
  if (opts.signal?.aborted) {
    return cancelTerminal(deps, runId, log);
  }

  // ─── Resolve the session if needed ──────────────────────────────────
  // The fix-dispatch loop requires a real session to inject messages
  // into; we resolve up-front so a "session was archived" surface
  // produces a clear failure before we burn rebase time.
  let sessionId: string | null = opts.sessionId ?? opts.card.session_id ?? null;
  let worktreePath = opts.worktreePath ?? null;
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
          'failed',
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
        'failed',
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
      'failed',
      'worktree_create_failed',
      'card has no session_id and no spawnSession dep wired',
      log,
    );
  }
  if (!worktreePath) {
    return terminate(
      deps,
      runId,
      'failed',
      'worktree_create_failed',
      'no worktree_path available for rebase phase',
      log,
    );
  }

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
  let parsedCi: CiConfig | null = null;

  while (loopCount < MAX_FIX_DISPATCH_LOOPS) {
    loopCount += 1;

    if (opts.signal?.aborted) {
      return cancelTerminal(deps, runId, log);
    }
    if (budgetExhausted(deps, runId, budgetSeconds, log)) {
      return terminate(
        deps,
        runId,
        'timed_out',
        'timeout',
        `active-time budget of ${budgetSeconds}s exhausted before loop ${loopCount}`,
        log,
      );
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
          env: opts.env,
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
    if (rebaseOutcome.kind === 'failed') {
      // Mirror the rebase failure onto the card BEFORE we propagate the
      // failure — `outcomeFromFailed` writes the terminal broadcasts but
      // does not touch the card surface. Only on first iteration to
      // avoid spamming on a fix-dispatch-loop rebase that later fails.
      if (loopCount === 1) {
        lifecycle.onRebaseAborted({ runId, detail: rebaseOutcome.detail });
      }
      return outcomeFromFailed(deps, runId, rebaseOutcome.failureReason, rebaseOutcome.detail);
    }
    if (rebaseOutcome.rebaseKind === 'skipped') {
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
      headValidatedAgainst = await resolveHead(worktreePath, opts.env);
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

    if (opts.signal?.aborted) {
      return cancelTerminal(deps, runId, log);
    }

    // ── Phase 3: reviewer ──────────────────────────────────────────
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
          env: opts.env,
          card: opts.card,
          project: opts.project,
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
    if (lastReviewerOutcome.kind === 'failed') {
      return outcomeFromFailed(
        deps,
        runId,
        lastReviewerOutcome.failureReason,
        lastReviewerOutcome.detail,
      );
    }
    // Mirror the verdict onto the card. Fires on EVERY loop iteration,
    // not just the first — the user wants to see the back-and-forth when
    // a `changes_requested` verdict triggers a fix dispatch and the next
    // pass produces a new verdict.
    lifecycle.onReviewerVerdict({ runId, verdict: lastReviewerOutcome.verdict });

    if (opts.signal?.aborted) {
      return cancelTerminal(deps, runId, log);
    }

    // ── Phase 4: tasks ──────────────────────────────────────────────
    try {
      lastStepOutcome = await runSteps(
        {
          stmts: deps.stmts,
          broadcast: deps.broadcast,
        },
        {
          runId,
          config: parsedCi,
          worktreePath,
          sessionId,
          env: opts.env,
        },
      );
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

    // Step terminal classes: the runner already wrote `failed` /
    // `timed_out` to the row for those classes, but NOT for `infra_error`
    // (§10 leaves that to the orchestrator).
    if (lastStepOutcome.status === 'timeout') {
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

    // ── Phase 5 + 7: combined gate (§3) + push gate (§9) ─────────────
    // The combined gate and the push gate fold together: we only
    // re-resolve HEAD when steps + reviewer agree, because the head-sha
    // check is the most expensive of the three (one extra git call) and
    // is meaningless when the first two conditions already refused.
    // When either of the first two fails we drop straight into fix
    // dispatch with the iteration's stale signals — that's the §6
    // behavior the loop invariant guarantees is safe.
    const stepsGreen = lastStepOutcome.status === 'success';
    const reviewerApproved = lastReviewerOutcome.verdict === 'approved';
    if (stepsGreen && reviewerApproved) {
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
        currentHead = await resolveHead(worktreePath, opts.env);
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
        stepStatus: lastStepOutcome.status,
        reviewerVerdict: lastReviewerOutcome.verdict,
        headBeforePhases: headValidatedAgainst,
        headAtPushGate: currentHead,
      });
      if (gateOutcome.kind === 'refuse') {
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

      // ── Phase 8: push ───────────────────────────────────────────
      // `headSha` passed downstream is the gate-validated sha — the sha
      // the reviewer approved and the steps ran green against, NOT the
      // trigger-time sha. Production's
      // `git push --force-with-lease=<branch>:<headSha>` uses this as
      // the expected remote ref, so it must reflect what's actually on
      // disk now.
      setPhase(deps, runId, 'push', 'pushing', log);
      let pushResult: PushAndCreatePrResult;
      try {
        pushResult = await deps.pushAndCreatePr({
          runId,
          worktreePath,
          branch: opts.branch,
          baseBranch: opts.baseBranch,
          headSha: gateOutcome.validatedHeadSha,
          card: opts.card,
          project: opts.project,
          env: opts.env,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return terminate(
          deps,
          runId,
          'infra_error',
          'github_push_5xx',
          `push step threw: ${msg}`,
          log,
        );
      }
      if (!pushResult.prUrl) {
        return terminate(
          deps,
          runId,
          'infra_error',
          'github_push_5xx',
          'push step returned empty pr_url',
          log,
        );
      }

      // Persist atomically: the provenance helper writes pr_url; we
      // then mark the row pushed + ended_at. Order matters — the
      // markFinalizeRunPushed write closes the lifecycle, so pr_url
      // MUST be persisted first so any read-back during the same tick
      // sees a complete row.
      try {
        writeFinalizeRunPrUrl({ stmts: deps.stmts }, { runId, prUrl: pushResult.prUrl });
        deps.stmts.markFinalizeRunPushed.run(runId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return terminate(
          deps,
          runId,
          'infra_error',
          'github_push_5xx',
          `persisting pr_url / pushed failed: ${msg}`,
          log,
        );
      }
      deps.broadcast({
        type: 'finalize_run_phase_changed',
        run_id: runId,
        phase: 'push',
        status: 'pushed',
      });
      deps.broadcast({
        type: 'finalize_run_completed',
        run_id: runId,
        status: 'pushed',
        pr_url: pushResult.prUrl,
      });
      // Mirror onto the card: post the PR URL comment and move the card
      // → Review (§15 post-push detach). The lifecycle impl handles the
      // ordering so the comment is in place by the time the column
      // re-render hits the UI.
      lifecycle.onPushed({ runId, prUrl: pushResult.prUrl });
      return { kind: 'pushed', runId, prUrl: pushResult.prUrl };
    }

    // ── Phase 6: fix dispatch ───────────────────────────────────────
    // Either steps failed, reviewer requested changes, or both. Build
    // the §7 trigger and inject the message; await turn-end and re-enter
    // the loop. The watchdog is armed inside `dispatchFixMessage` for
    // `ui_button` triggers only.
    const trigger = buildFixTrigger(deps, runId, lastStepOutcome, lastReviewerOutcome, log);
    // Mirror a step failure onto the card — exactly when there IS a
    // failed step AND the fix-dispatch loop is about to run. Reviewer-
    // only `changes_requested` cases (no failed step) are already
    // covered by `onReviewerVerdict` above; we deliberately don't
    // double-comment.
    if (lastStepOutcome.failedStep) {
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

    let fix: FixDispatchResult;
    try {
      fix = await dispatchFix(
        {
          stmts: deps.stmts,
          broadcast: deps.broadcast,
          turnEnd: deps.turnEnd,
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

    if (fix.outcome === 'stalled_no_response') {
      // The watchdog already wrote the terminal status; just surface.
      // Mirror the stall onto the card — this is the "human walked away"
      // branch (see card `490d6c41`); the comment names the two recovery
      // actions so the user has a clear next step.
      lifecycle.onStalled({ runId });
      return { kind: 'stalled', runId };
    }
    if (fix.outcome === 'cancelled') {
      return cancelTerminal(deps, runId, log);
    }
    // `turn_ended` — the session committed (or at least ended its turn).
    // We re-enter at the top of the loop. The next iteration's rebase
    // pass will refresh the worktree state and the reviewer + step
    // verdicts will be reproduced against the new HEAD.
  }

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
}

// ─── Helpers ──────────────────────────────────────────────────────────

function setPhase(
  deps: OrchestratorDeps,
  runId: string,
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
  deps.broadcast({
    type: 'finalize_run_phase_changed',
    run_id: runId,
    phase: null,
    status,
    failure_reason: failureReason,
  });
  deps.broadcast({
    type: 'finalize_run_completed',
    run_id: runId,
    status,
    failure_reason: failureReason,
  });
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
  deps.broadcast({
    type: 'finalize_run_phase_changed',
    run_id: runId,
    phase: null,
    status: 'cancelled',
    failure_reason: 'cancelled',
  });
  deps.broadcast({
    type: 'finalize_run_completed',
    run_id: runId,
    status: 'cancelled',
  });
  return { kind: 'cancelled', runId };
}

/**
 * Read the current `active_seconds_consumed` and return true if it has
 * crossed the budget. The orchestrator does NOT bill active time itself
 * — every phase module bills its own units; this helper only reads back
 * the running total against the cap.
 */
function budgetExhausted(
  deps: OrchestratorDeps,
  runId: string,
  budgetSeconds: number,
  log: (msg: string) => void,
): boolean {
  try {
    const row = deps.stmts.getFinalizeRun.get(runId) as FinalizeRunRow | undefined;
    if (!row) return false;
    return row.active_seconds_consumed >= budgetSeconds;
  } catch (err) {
    log(
      `[finalize-orchestrator] budget check failed for run=${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
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
  // Mirror what `terminate()` emits so subscribers see the same shape on
  // every terminal path, regardless of which phase produced the failure.
  // The sub-phase already wrote the row's terminal status (status,
  // failure_reason, ended_at); we do not re-write here.
  deps.broadcast({
    type: 'finalize_run_phase_changed',
    run_id: runId,
    phase: null,
    status,
    failure_reason: failureReason,
  });
  deps.broadcast({
    type: 'finalize_run_completed',
    run_id: runId,
    status,
    failure_reason: failureReason,
  });
  return { kind: 'failed', runId, status, failureReason, detail };
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
): FixDispatchTrigger {
  const trigger: FixDispatchTrigger = {};
  if (stepOutcome?.failedStep) {
    trigger.failedStep = {
      phase: 'tasks',
      name: stepOutcome.failedStep.name,
      exitCode: stepOutcome.failedStep.exitCode,
      outputTail: stepOutcome.failedStep.outputTail,
    };
  }
  if (reviewerOutcome?.kind === 'success') {
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
  buildFixTrigger,
  isTriggerEmpty,
  outcomeFromFailed,
  budgetExhausted,
  MAX_FIX_DISPATCH_LOOPS,
  DEFAULT_CI_CONFIG_RELATIVE_PATH,
};

// Suppress the unused-import warning for ReviewerLocalDiffInputs — it is
// re-exported here so callers of the orchestrator can construct
// reviewer-driver inputs without importing the sub-module directly.
export type { ReviewerLocalDiffInputs };
