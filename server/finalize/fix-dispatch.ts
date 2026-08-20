/**
 * fix-dispatch.ts — Finalize Code Changes, dispatch-fix step.
 *
 * Per wiki `finalize-code-changes-architecture-v0` §6–§7: when a step
 * fails OR the reviewer requests changes, the orchestrator injects a
 * structured §7 message into the **originating session** (the session
 * the human has been collaborating with in live mode, or the
 * autonomous-mode session the dispatcher assigned) and then awaits
 * **turn-end** before re-entering the rebase phase.
 *
 * There is no Hub CI agent and no separate fixer identity (§6). The
 * session's agent reads its own chat, edits the worktree, commits, and
 * ends its turn. Author and committer of any resulting commits are the
 * session agent's normal identity — no author/committer split, no
 * synthetic bot trailer.
 *
 * This module owns three responsibilities:
 *
 *   1. **Compose** the §7 message body from the trigger context (failed
 *      step + reviewer threads) using the canonical format locked in
 *      the design doc.
 *   2. **Inject** the message into the session via the existing
 *      `addMessage` infra (role `'system'`, a `kind:
 *      'finalize_fix_dispatch'` metadata tag so the chat UI can render
 *      it distinctly). Broadcasts a `message` event so live subscribers
 *      see it without reloading and flips `finalize_runs.phase =
 *      'dispatching'`.
 *   3. **Wait** for the originating session to end its next turn. Turn-
 *      end is the only signal that re-enters rebase — no explicit
 *      "I'm done" handshake. In live mode, the stall watchdog
 *      (`server/finalize/stall-watchdog.ts`) is armed in parallel so a
 *      walked-away human surfaces as a push notification and
 *      eventually a `stalled_no_response` terminal state.
 *
 * Uniform across live and autonomous modes (`trigger_source =
 * 'ui_button'` or `'agent_block'`): the message shape, the turn-end
 * signal, and the active-time billing are identical. The only branch is
 * the stall watchdog, which is armed in live mode only. Autonomous
 * runs that never produce a turn-end are a bug in the autonomous
 * dispatcher (surfaces as `dispatch_failure` elsewhere) — Finalize does
 * not park them as stalled.
 *
 * No per-attempt cap on the fix loop. Per §13, the only ceiling is the
 * 60-minute active-time budget, which the orchestrator enforces across
 * the whole run. While we are awaiting a turn-end the active-time clock
 * is paused, so a slow human (or a long-running fixer turn) does not
 * burn the budget faster than its actual processing time.
 */
import { v4 as uuidv4 } from 'uuid';
import type {
  BroadcastFn,
  FinalizeRunPhase,
  MessageRow,
  ReviewerThreadRow,
  Stmts,
} from '../types.js';
import { formatThreadsForDispatchBody } from './reviewer-dispatch.js';
import {
  looksLikeRunnerTeardownForHint,
  RUNNER_TEARDOWN_DISPATCH_HINT,
} from './runner-teardown.js';
import {
  armStallWatchdog,
  DEFAULT_NOTIFY_AFTER_MS,
  DEFAULT_STALL_AFTER_MS,
  type StallWatchdogDeps,
  type StallWatchdogHandle,
} from './stall-watchdog.js';

/**
 * Active-seconds billed on entry to the dispatching phase. Keeps the
 * counter advancing for runs that loop through multiple dispatches —
 * we want the §13 budget to actually progress even if the
 * orchestrator's other phases are momentarily idle. Mirrors the
 * `TASKS_PHASE_ENTRY_ACTIVE_SECONDS` charge in the step runner.
 */
export const DISPATCH_PHASE_ENTRY_ACTIVE_SECONDS = 1;

/**
 * Trailer the §7 dispatch body ends with. Locked to the wording from
 * the design doc so the chat UI / autonomous agents can recognise the
 * end of the structured prompt.
 */
export const DISPATCH_TRAILER =
  'Please fix and commit. The pipeline will re-run automatically when you finish your turn. ' +
  'You do NOT have the web run-timeline UI, so to read why a step failed use the agent-hub skill: ' +
  '`finalize.sh failed` dumps full logs for every failed step, `finalize.sh latest` lists per-step ' +
  'pass/fail, and `finalize.sh output <stepIndex>` shows one step. (Equivalent REST: ' +
  'GET /api/sessions/:sessionId/finalize-runs/latest and ' +
  'GET /api/projects/:projectId/finalize/:runId/steps/:stepIndex/output.) ' +
  'Do not re-run the full `.agent-hub/ci.yaml` suite locally — run only targeted tests for the failing case if needed.';

/** Trailer for reviewer-only dispatches — CI is deferred until approval. */
export const DISPATCH_TRAILER_REVIEWER =
  'Please address the reviewer feedback and commit. When you finish your turn, review will run again; CI runs only after the reviewer approves. Do not re-run the full `.agent-hub/ci.yaml` suite locally unless you need a targeted check for a specific change.';

/**
 * Payload describing the failed step that triggered this dispatch.
 * Mirrors the shape the step runner's `StepRunResult.failedStep`
 * already produces so the orchestrator can pass it through unchanged.
 */
export interface FailedStepContext {
  /**
   * Phase the failure landed in. Defaults to `'tasks'` because that is
   * the phase declared in §7 ("phase=tasks, step ..."); reviewer-only
   * dispatches that also carry a failed step (none today; future-proof)
   * may pass `'review'`.
   */
  phase: 'tasks' | 'review';
  /** Display name from ci.yaml (parse-time default applied). */
  name: string;
  /** Exit code; `-1` sentinel for the timeout / spawn-error path. */
  exitCode: number;
  /** Trailing-N-line snapshot from the step's mixed stdout+stderr stream. */
  outputTail: string[];
  /**
   * Signal-aware excerpt: the lines that matched a failure marker plus
   * surrounding context (see the step runner's `FailureExcerptCollector`).
   * The dispatch body leads with this so the agent sees the real failure
   * even when a chatty sidecar has flooded the trailing {@link outputTail}.
   * Empty / absent when no failure marker was detected.
   */
  failureExcerpt?: string[];
  /** Job id this failure came from (v2 parallel jobs). Used to label which
   * job failed when several reds are surfaced in one dispatch. */
  jobId?: string;
  /** Matrix shard key (v2 matrix). Combined with {@link jobId} to
   * disambiguate per-shard failures in a multi-failure dispatch. */
  matrixKey?: string;
}

/**
 * Composite trigger context. The orchestrator builds this when **any**
 * of {failed-step, reviewer-changes-requested} happens. Per the §3
 * `Combined` gate, both can trip in the same dispatch — `failedStep`
 * and `reviewerThreads` are not mutually exclusive.
 */
export interface FixDispatchTrigger {
  /**
   * Primary failed-step context; null when only the reviewer requested
   * changes. When several parallel jobs failed in the same round this is the
   * lead failure — the full set is in {@link failedSteps}.
   */
  failedStep?: FailedStepContext | null;
  /**
   * Every failed step from the round, when more than one parallel job/shard
   * went red. The checks scheduler waits for ALL jobs to finish before the
   * orchestrator dispatches, so a single fix turn can address every failure at
   * once. When present (length ≥ 2) the dispatch body enumerates each red;
   * when absent or length ≤ 1 the body uses {@link failedStep} alone (the
   * legacy single-failure shape, unchanged).
   */
  failedSteps?: FailedStepContext[] | null;
  /**
   * Reviewer threads from the latest review pass on this head. May be
   * empty when only a step failed and the reviewer hadn't run yet (no
   * threads to surface), or non-empty when the reviewer requested
   * changes (with or without a step failure).
   */
  reviewerThreads?: ReviewerThreadRow[];
  /**
   * Reviewer's verdict on the current head. Drives the message header
   * when there is no failed step. `'approved'` should never reach this
   * helper (no dispatch needed), but the type accepts it so the
   * orchestrator can pass through whatever it has without sanitising.
   */
  reviewerVerdict?: 'approved' | 'changes_requested' | null;
  /**
   * Set when the reviewer has flagged the same file/area cluster for N
   * consecutive rounds (see review-cluster-tracker). Escalates the dispatch
   * body from per-line fixes to a root-cause directive and carries the prior
   * rounds' findings for the recurring cluster so the fix turn sees the whole
   * pattern, not just the current round.
   */
  rootCauseEscalation?: {
    clusters: string[];
    rounds: number;
    priorFindings: string[];
  } | null;
}

/**
 * Result of one dispatch round. Resolves when **either** the session
 * produces a turn-end OR the stall watchdog terminates the run.
 *
 *   - `'turn_ended'` — the session emitted `done` for the originating
 *     `sessionId`. Orchestrator re-enters rebase.
 *   - `'stalled_no_response'` — live mode only. Watchdog tripped after
 *     the configured stall window. The run is already persisted as
 *     terminal; the orchestrator should NOT re-enter rebase.
 *   - `'cancelled'` — the caller (or a parent abort signal) requested
 *     cancellation. Watchdog timers cleared; no terminal status written
 *     here — the cancel path owns that.
 *   - `'spawn_failed'` — the agent CLI never started (E2BIG, ENOENT, …).
 *     Orchestrator should fail the run — not re-enter the loop with no fix.
 */
export type FixDispatchOutcome =
  | 'turn_ended'
  | 'stalled_no_response'
  | 'cancelled'
  | 'spawn_failed';

export interface FixDispatchResult {
  outcome: FixDispatchOutcome;
  /** Inserted session message id (the §7 prompt). */
  messageId: string;
  /** Active-seconds billed on entry. The orchestrator may have already paid; see {@link FixDispatchOptions.skipActiveSecondsCharge}. */
  activeSecondsBilled: number;
}

/**
 * Subscriber contract for the originating session's turn-end signal.
 * Production wires this through the broadcast pipeline (a tap that
 * listens for `{ type: 'done', sessionId }`) — see the orchestrator
 * card. Tests inject a fake that exposes a `fire()` method.
 *
 * `subscribe` returns an unsubscribe fn. The helper calls it on every
 * exit path so we never leak listeners.
 */
export interface TurnEndSubscriber {
  subscribe(
    sessionId: string,
    onTurnEnd: (outcome: 'turn_ended' | 'spawn_failed') => void,
  ): () => void;
}

/**
 * Cancellation signal. Matches a subset of `AbortSignal` so the
 * orchestrator can pass its own abort directly through. Tests inject a
 * tiny stub.
 */
export interface CancelSignal {
  /** True if cancellation has already been requested before subscribe. */
  readonly aborted: boolean;
  /** Listener registration; called at most once. Returns unregister fn. */
  onAbort(listener: () => void): () => void;
}

export interface SpawnFixTurnFn {
  (args: { sessionId: string; body: string }): Promise<{ spawned: boolean }>;
}

export interface FixDispatchDeps {
  stmts: Pick<
    Stmts,
    | 'addMessage'
    | 'getMessageById'
    | 'touchSession'
    | 'updateFinalizeRunPhase'
    | 'updateFinalizeRunActiveSeconds'
    | 'failFinalizeRun'
  >;
  broadcast: BroadcastFn;
  turnEnd: TurnEndSubscriber;
  /**
   * Spawn the originating session agent after the §7 system message is
   * inserted. Production wires `createSpawnFinalizeFixTurn`; without it
   * the run parks at "awaiting fix" forever.
   */
  spawnFixTurn?: SpawnFixTurnFn;
  /** Dep bundle handed to the stall watchdog; see {@link StallWatchdogDeps}. */
  stallWatchdog?: Omit<StallWatchdogDeps, 'broadcast' | 'stmts'>;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Idempotent id minter for the dispatched message. */
  newId?: () => string;
  /** Log sink; tests stub. */
  log?: (msg: string) => void;
}

export interface FixDispatchOptions {
  /** finalize_runs.id. */
  runId: string;
  /** Originating session id — the message is dropped into this transcript. */
  sessionId: string;
  /** Project id — propagated to push payload + session message metadata. */
  projectId: string;
  /** Card id — propagated to push payload + session message metadata. */
  cardId: string;
  /**
   * Trigger source for the parent finalize run. Drives whether the
   * stall watchdog arms (`'ui_button'` → yes; `'agent_block'` → no).
   */
  triggerSource: 'ui_button' | 'agent_block';
  /** Card title — woven into the stall watchdog's push body. */
  cardTitle?: string;
  /** The actual fail signal that triggered this dispatch. */
  trigger: FixDispatchTrigger;
  /**
   * Explicit message body. When set, it is used verbatim instead of composing
   * one from {@link trigger}. Used by the orchestrator's §6 no-progress nudge,
   * which is not a step / reviewer failure but a "you left work uncommitted"
   * prompt. When omitted, the body is composed from `trigger` as usual.
   */
  bodyOverride?: string;
  /**
   * Per-project stall-watchdog notify window override. Passed straight
   * through to {@link armStallWatchdog} (clamped + sanitised there).
   */
  notifyAfterMs?: number;
  /**
   * Per-project stall-watchdog stall window override. Passed straight
   * through to {@link armStallWatchdog}.
   */
  stallAfterMs?: number;
  /** Optional cancel signal. Callers wire their own abort logic through. */
  signal?: CancelSignal;
  /**
   * When true, the dispatch-phase entry active-seconds charge is
   * skipped. Use case: the orchestrator already billed the phase
   * transition itself (e.g. through `failFinalizeRun`'s caller) and
   * the helper would be double-charging. Default false (charge here).
   */
  skipActiveSecondsCharge?: boolean;
}

/**
 * One round of fix-dispatch. Resolves when the session turn ends OR
 * the stall watchdog terminates OR the caller cancels.
 *
 * Side effects (in order):
 *
 *   1. `finalize_runs.phase = <originating phase>` (`'tasks'` for a
 *      checks-failure fix, `'review'` for a reviewer fix), `status =
 *      'dispatching'` via `updateFinalizeRunPhase` + broadcast. The phase is
 *      preserved (not clobbered to `'dispatching'`) so a cold fetch / reconnect
 *      mid-fix can still tell which kind of fix is in flight.
 *   2. `finalize_runs.active_seconds_consumed += DISPATCH_PHASE_ENTRY_ACTIVE_SECONDS`
 *      (skippable via {@link FixDispatchOptions.skipActiveSecondsCharge}).
 *   3. Insert the composed §7 message into the session via
 *      `addMessage` (role `'system'`); broadcast `{ type: 'message' }`.
 *   4. Subscribe to turn-end on the session.
 *   5. Arm the stall watchdog (live mode only).
 *   6. Spawn the originating session agent.
 *   7. Await whichever resolves first.
 *
 * Non-throwing: every failure becomes a tagged outcome. A DB write
 * failure on step 1 still attempts steps 2–3 (best-effort); a message
 * insert failure aborts with `'cancelled'` so the orchestrator can
 * surface the infra error.
 */
export async function dispatchFixMessage(
  deps: FixDispatchDeps,
  opts: FixDispatchOptions,
): Promise<FixDispatchResult> {
  const { stmts, broadcast } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? uuidv4;
  const log = deps.log ?? ((msg: string) => console.warn(msg));

  // Compose the body up-front so a malformed trigger (no failed step
  // AND no threads) surfaces here, not after we've already touched the
  // DB. Empty body would be a meaningless prompt for the agent. A caller may
  // pass an explicit `bodyOverride` (the no-progress nudge) which bypasses
  // trigger composition entirely.
  const body = opts.bodyOverride?.trim() ? opts.bodyOverride : composeDispatchBody(opts.trigger);
  if (!body.trim()) {
    log(
      `[finalize-fix-dispatch] refusing to dispatch empty message for run=${opts.runId} — trigger had no failed step and no reviewer threads`,
    );
    return { outcome: 'cancelled', messageId: '', activeSecondsBilled: 0 };
  }

  // Phase + status flip. We write BEFORE the message insert so a UI
  // subscriber that joins between the broadcast and the insert sees
  // the dispatching state at minimum.
  //
  // PRESERVE the originating phase — `'tasks'` for a checks-failure fix,
  // `'review'` for a reviewer-requested-changes fix — instead of clobbering
  // it to `'dispatching'`. The `status` column already carries the
  // awaiting-fix state (`status === 'dispatching'`); the `phase` column must
  // stay the phase being fixed so a cold mount / WebSocket reconnect DURING
  // the fix window can reconstruct WHICH kind of fix is in flight. The client
  // derives `awaitingChecksFix` (what keeps the live checks block on screen)
  // from `status === 'dispatching' && phase === 'tasks'`; once `phase` was
  // overwritten with `'dispatching'`, that became underivable from any
  // fetch-based recovery — so the live checks block silently vanished for the
  // entire fix loop on every FAILED checks round, reappearing only as the
  // persisted round message after the round completed ("tests only show after
  // they finish, and only when there's a failure"). Mirrors `rebase.ts`,
  // which already keeps `phase === 'rebase'` on its conflict-fix dispatch.
  const originPhase: FinalizeRunPhase = opts.trigger.failedStep?.phase ?? 'review';
  try {
    stmts.updateFinalizeRunPhase.run(originPhase, 'dispatching', opts.runId);
    broadcast({
      type: 'finalize_run_phase_changed',
      run_id: opts.runId,
      session_id: opts.sessionId,
      phase: originPhase,
      status: 'dispatching',
    });
  } catch (err) {
    // Phase write is best-effort. The dispatch is still useful to the
    // agent even if the row is mid-transaction lock — surface and
    // continue.
    log(
      `[finalize-fix-dispatch] phase write failed for run=${opts.runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let activeSecondsBilled = 0;
  if (!opts.skipActiveSecondsCharge) {
    try {
      stmts.updateFinalizeRunActiveSeconds.run(DISPATCH_PHASE_ENTRY_ACTIVE_SECONDS, opts.runId);
      activeSecondsBilled = DISPATCH_PHASE_ENTRY_ACTIVE_SECONDS;
    } catch (err) {
      log(
        `[finalize-fix-dispatch] active-seconds bump failed for run=${opts.runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const messageId = newId();
  const metadata = JSON.stringify({
    kind: 'finalize_fix_dispatch',
    runId: opts.runId,
    cardId: opts.cardId,
    projectId: opts.projectId,
    triggerSource: opts.triggerSource,
    failedStepName: opts.trigger.failedStep?.name ?? null,
    failedStepExitCode: opts.trigger.failedStep?.exitCode ?? null,
    reviewerVerdict: opts.trigger.reviewerVerdict ?? null,
    reviewerThreadCount: opts.trigger.reviewerThreads?.length ?? 0,
    dispatchedAt: now(),
  });

  try {
    stmts.addMessage.run(
      messageId,
      opts.sessionId,
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
    // We cannot recover from a failed message insert — the agent will
    // never see the prompt. Surface as cancelled so the orchestrator
    // can decide whether to retry or fail terminal. Persist nothing
    // else here; the row's existing phase/status stand.
    log(
      `[finalize-fix-dispatch] addMessage failed for session=${opts.sessionId} run=${opts.runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { outcome: 'cancelled', messageId, activeSecondsBilled };
  }
  try {
    stmts.touchSession.run(opts.sessionId);
  } catch {
    /* best-effort */
  }
  try {
    const inserted = stmts.getMessageById.get(messageId) as MessageRow | undefined;
    if (inserted) {
      broadcast({ type: 'message', sessionId: opts.sessionId, message: inserted });
    }
  } catch (err) {
    log(
      `[finalize-fix-dispatch] message broadcast failed for session=${opts.sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Pre-cancel: caller already aborted before we set up the wait
  // primitives. Skip both watchdog, turn-end subscription, and spawn.
  if (opts.signal?.aborted) {
    return { outcome: 'cancelled', messageId, activeSecondsBilled };
  }

  // Set up turn-end + watchdog with a single shared resolver so each
  // resolution path is mutually exclusive.
  return new Promise<FixDispatchResult>((resolve) => {
    let settled = false;

    let watchdog: StallWatchdogHandle | null = null;
    let unsubscribeTurnEnd: (() => void) | null = null;
    let unsubscribeCancel: (() => void) | null = null;

    const finish = (outcome: FixDispatchOutcome): void => {
      if (settled) return;
      settled = true;
      try {
        watchdog?.cancel();
      } catch {
        /* best-effort */
      }
      try {
        unsubscribeTurnEnd?.();
      } catch {
        /* best-effort */
      }
      try {
        unsubscribeCancel?.();
      } catch {
        /* best-effort */
      }
      resolve({ outcome, messageId, activeSecondsBilled });
    };

    // Subscribe to turn-end first so a same-tick `done` event that
    // fires synchronously during watchdog setup is not missed.
    try {
      unsubscribeTurnEnd = deps.turnEnd.subscribe(opts.sessionId, (outcome) =>
        finish(outcome === 'spawn_failed' ? 'spawn_failed' : 'turn_ended'),
      );
    } catch (err) {
      log(
        `[finalize-fix-dispatch] turn-end subscribe failed for session=${opts.sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      finish('cancelled');
      return;
    }

    if (opts.signal) {
      try {
        unsubscribeCancel = opts.signal.onAbort(() => finish('cancelled'));
      } catch (err) {
        log(
          `[finalize-fix-dispatch] cancel-signal subscribe failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Arm watchdog. Autonomous mode no-ops inside armStallWatchdog —
    // the returned handle is valid but neither timer is set.
    watchdog = armStallWatchdog(
      {
        stmts,
        broadcast,
        ...(deps.stallWatchdog ?? {}),
      },
      {
        runId: opts.runId,
        sessionId: opts.sessionId,
        projectId: opts.projectId,
        cardId: opts.cardId,
        triggerSource: opts.triggerSource,
        cardTitle: opts.cardTitle,
        notifyAfterMs: opts.notifyAfterMs,
        stallAfterMs: opts.stallAfterMs,
      },
      () => finish('stalled_no_response'),
    );

    if (deps.spawnFixTurn) {
      void deps
        .spawnFixTurn({ sessionId: opts.sessionId, body })
        .then((spawnResult) => {
          if (!spawnResult.spawned) {
            log(
              `[finalize-fix-dispatch] agent spawn did not start for session=${opts.sessionId} run=${opts.runId}`,
            );
            finish('spawn_failed');
          }
        })
        .catch((err: unknown) => {
          log(
            `[finalize-fix-dispatch] spawnFixTurn failed for session=${opts.sessionId} run=${
              opts.runId
            }: ${err instanceof Error ? err.message : String(err)}`,
          );
          finish('spawn_failed');
        });
    } else {
      log(
        `[finalize-fix-dispatch] spawnFixTurn not wired — session ${opts.sessionId} will not auto-respond`,
      );
    }
  });
}

// ─── §7 message composer ────────────────────────────────────────────

/**
 * Build the §7 fix-dispatch body. Locked to the wiki shape; render is
 * pure so the orchestrator and tests share one formatter.
 *
 * Skeleton:
 *
 *     Finalize Code Changes: phase=<phase>, step "<name>" failed (exit <code>).
 *     (or)
 *     Finalize Code Changes: phase=review, reviewer requested changes.
 *
 *     Last output (40 lines):
 *     <stdout/stderr tail>
 *
 *     Reviewer notes:
 *     - <file>:<line> — <comment>
 *
 *     Please fix and commit. The pipeline will re-run automatically when you finish your turn.
 *
 * Empty input produces an empty string — the caller treats that as
 * "no useful dispatch, do not send".
 */
/** Human label for which job/shard a failure came from (v2 parallel jobs). */
function failedStepJobLabel(f: FailedStepContext): string {
  if (f.jobId && f.matrixKey) return `job "${f.jobId}" / shard "${f.matrixKey}"`;
  if (f.jobId) return `job "${f.jobId}"`;
  return '';
}

/**
 * Render one failed step's evidence block (teardown hint → excerpt → tail).
 * Shared by the single- and multi-failure code paths so both lay out the
 * excerpt/tail identically.
 */
function renderFailedStepEvidence(f: FailedStepContext): string[] {
  const lines: string[] = [];

  // Layer B safety net: if this failed step looks like a runner teardown
  // (Go `context canceled` sentinel, no test-failure summary) rather than a
  // real red, lead with a hint so the agent doesn't chase a phantom failure.
  // Layer A reclassifies clean teardowns as infra_error before they reach
  // dispatch, so the cases that survive to here are exactly the ones Layer
  // A's strict terminal-window detector rejected — which is why this uses the
  // BROADER `looksLikeRunnerTeardownForHint` (sentinel anywhere, not just the
  // terminal window). Using the strict predicate here would be dead code: a
  // failedStep only reaches dispatch when the strict check already returned
  // false. The hint is advisory and never suppresses CI, so the looser match
  // is safe.
  if (
    looksLikeRunnerTeardownForHint({
      outputTail: f.outputTail,
      failureExcerpt: f.failureExcerpt,
    })
  ) {
    lines.push('');
    lines.push(RUNNER_TEARDOWN_DISPATCH_HINT);
  }

  // Lead with the signal-aware excerpt when we have one — it points at the
  // actual failure (test summary, stack trace) rather than whatever
  // happened to be last in the raw stream. The trailing tail still follows
  // as a fallback / for the surrounding raw context.
  const failureExcerpt = f.failureExcerpt ?? [];
  if (failureExcerpt.length > 0) {
    lines.push('');
    lines.push('Likely failure (excerpt):');
    for (const t of failureExcerpt) lines.push(t);
  }

  const tail = f.outputTail ?? [];
  lines.push('');
  lines.push('Last output (40 lines):');
  if (tail.length === 0) {
    lines.push('(no output captured)');
  } else {
    for (const t of tail) lines.push(t);
  }

  return lines;
}

export function composeDispatchBody(trigger: FixDispatchTrigger): string {
  // The full failure set takes precedence when the round had ≥2 reds across
  // parallel jobs; otherwise fall back to the single primary failure so the
  // legacy one-failure output is byte-for-byte unchanged.
  const failedSteps =
    trigger.failedSteps && trigger.failedSteps.length >= 2
      ? trigger.failedSteps
      : trigger.failedStep
        ? [trigger.failedStep]
        : [];
  const hasFailedStep = failedSteps.length > 0;
  const multiFailure = failedSteps.length >= 2;
  const threads = trigger.reviewerThreads ?? [];
  const hasReviewerNotes = threads.length > 0;
  const reviewerChangesRequested = trigger.reviewerVerdict === 'changes_requested';

  if (!hasFailedStep && !hasReviewerNotes && !reviewerChangesRequested) {
    return '';
  }

  const lines: string[] = [];

  if (multiFailure) {
    // Several parallel jobs went red in the same round. Because the scheduler
    // waited for every job before dispatching, surface all of them in one turn
    // so the agent fixes them together instead of one-per-round.
    const phase = failedSteps[0].phase;
    lines.push(
      `Finalize Code Changes: phase=${phase}, ${failedSteps.length} steps failed across CI jobs.`,
    );
    failedSteps.forEach((f, i) => {
      lines.push('');
      const where = failedStepJobLabel(f);
      lines.push(
        `Failure ${i + 1} of ${failedSteps.length} — ${
          where ? `${where}, ` : ''
        }step "${f.name}" failed (exit ${f.exitCode}).`,
      );
      lines.push(...renderFailedStepEvidence(f));
    });
  } else if (hasFailedStep) {
    const f = failedSteps[0];
    lines.push(
      `Finalize Code Changes: phase=${f.phase}, step "${f.name}" failed (exit ${f.exitCode}).`,
    );
    lines.push(...renderFailedStepEvidence(f));
  } else {
    // Reviewer-only dispatch. The header phase matches the design doc
    // wording ("phase=review, reviewer requested changes.") regardless
    // of which side of the gate the orchestrator entered from.
    lines.push('Finalize Code Changes: phase=review, reviewer requested changes.');
  }

  // Root-cause escalation preamble — surfaced BEFORE the current round's notes
  // so the fixer reads the pattern first. Only present once a cluster has
  // recurred across rounds (the per-site fixes were not converging).
  const esc = trigger.rootCauseEscalation;
  if (esc && esc.clusters.length > 0) {
    lines.push('');
    lines.push(
      `Root-cause escalation: the reviewer has flagged ${esc.clusters.join(', ')} for ` +
        `${esc.rounds} rounds running. These are almost certainly instances of ONE underlying ` +
        `defect, not separate bugs — the per-line fixes so far have not converged. Stop patching ` +
        `individual lines: fix the root cause, then re-scan every sibling call site in the same ` +
        `area for the same class of problem before ending your turn.`,
    );
    if (esc.priorFindings.length > 0) {
      lines.push('');
      lines.push('Earlier rounds flagged the same area:');
      for (const pf of esc.priorFindings) lines.push(pf);
    }
  }

  if (hasReviewerNotes) {
    const formatted = formatThreadsForDispatchBody(threads);
    if (formatted.length > 0) {
      lines.push('');
      lines.push(formatted);
    }
  } else if (reviewerChangesRequested) {
    // The verdict says changes were requested but no anchored threads
    // were produced — surface that explicitly so the agent isn't left
    // guessing what the reviewer wanted.
    lines.push('');
    lines.push('Reviewer notes:');
    lines.push('- (no anchored notes — verdict was changes_requested without per-file findings)');
  }

  lines.push('');
  lines.push(hasFailedStep ? DISPATCH_TRAILER : DISPATCH_TRAILER_REVIEWER);

  return lines.join('\n');
}

export const __test = {
  DEFAULT_NOTIFY_AFTER_MS,
  DEFAULT_STALL_AFTER_MS,
};
