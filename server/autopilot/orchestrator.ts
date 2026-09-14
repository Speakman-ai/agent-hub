import type Database from 'better-sqlite3';
import { AutopilotError, isAutopilotError } from './errors.js';
import { AutopilotStore } from './store.js';
import type { AutopilotController } from './controller.js';
import type { AutopilotOperationRecord, AutopilotRunSnapshot } from './types.js';

/**
 * Orchestration driver for an Autopilot cycle's plan → implement → finalize
 * spine. It sits on top of the persistent controller: the controller owns
 * leases, fencing, retries, envelopes and idempotent operation settlement;
 * the orchestrator owns the stage sequencing and the external side effects
 * (planning, board scaffolding, session dispatch, Finalize) behind injectable
 * ports so tests can drive it with deterministic fakes and it never spawns a
 * real agent CLI or touches a live deployment.
 *
 * Cycle advancement is gated on exact-revision results, not assistant
 * completion text or a card entering Done: only a Finalize result that reports
 * `merged` with a real merged SHA and an approved review advances the cycle.
 */

/**
 * A resolved acceptance journey: a concrete end-user action and the observable
 * resulting state a browser test can assert. Both halves are required — a
 * journey is never a raw brief sentence.
 */
export interface AutopilotAcceptanceJourney {
  /** Concrete end-user action, e.g. "submit a new todo item via the add form". */
  action: string;
  /** Observable resulting state, e.g. "the new item appears in the todo list". */
  expectedResult: string;
}

/** Expanded baseline the planner locks before any work is filed. */
export interface AutopilotBaselineSpec {
  assumptions: string[];
  acceptanceJourneys: AutopilotAcceptanceJourney[];
  nonGoals: string[];
  specDecisions: { key: string; decision: string }[];
  qualityRubricVersion: number;
}

export interface AutopilotPlannerInput {
  projectId: string;
  runId: string;
  brief: string;
  briefRevision: number;
}

export interface AutopilotPlannerPort {
  /**
   * Expand a loose brief into a concrete baseline. The planner may lock real
   * spec decisions but must not expand scope or permissions; callers treat a
   * thrown error as a planning failure (retryable by the controller).
   */
  expandBrief(input: AutopilotPlannerInput): Promise<AutopilotBaselineSpec>;
}

export interface AutopilotPlannedCard {
  cardId: string;
  title: string;
  phase: number;
  blockedBy: string[];
}

export interface AutopilotPlannedBoard {
  epicId: string;
  primaryCardId: string;
  cards: AutopilotPlannedCard[];
}

export interface AutopilotBoardPort {
  /**
   * Create the linked epic/phase/cards + blocker edges for the baseline.
   * `idempotencyKey` is stable per run+cycle so a retry after a partial
   * failure reuses the same board identity instead of filing duplicate work.
   */
  createBaselineBoard(input: {
    projectId: string;
    runId: string;
    idempotencyKey: string;
    spec: AutopilotBaselineSpec;
  }): Promise<AutopilotPlannedBoard>;
  /**
   * Validate the saved phase/dependency order. Returns `ok: false` (with a
   * reason) when the phase graph has a cycle or a blocker points backwards so
   * the orchestrator can fail planning instead of dispatching an unorderable
   * plan.
   */
  validatePhaseOrder(input: {
    projectId: string;
    epicId: string;
  }): Promise<{ ok: boolean; reason?: string }>;
}

/** Enforced bounds a dispatched worker must run under. */
export interface AutopilotSessionBounds {
  maxStageTimeoutMs: number;
}

/** Structured handoff the implementation worker receives. */
export interface AutopilotImplementationContext {
  specRevision: number | null;
  cardId: string;
  acceptanceJourneys: AutopilotAcceptanceJourney[];
  nonGoals: string[];
  specDecisions: { key: string; decision: string }[];
}

export interface AutopilotSessionPort {
  /**
   * Start a bounded implementation session with structured handoff context.
   * `operationId` is the reserved controller operation's durable identity: the
   * adapter keys the external launch on it so a repeated call with the same id
   * deduplicates instead of launching a second session. The session commits
   * locally on its worktree branch; it does not push, open a PR or merge —
   * Finalize automation owns those gates.
   */
  dispatchImplementation(input: {
    projectId: string;
    runId: string;
    operationId: string;
    cardId: string;
    workerKeyName: string | null;
    bounds: AutopilotSessionBounds;
    context: AutopilotImplementationContext;
  }): Promise<{ sessionId: string }>;
}

export interface AutopilotFinalizePort {
  /**
   * Invoke the existing Finalize review/CI/merge automation under the run's
   * scoped worker identity. `operationId` is the reserved operation's durable
   * identity for dedup/recovery. Formal reviewer ownership and every gate stay
   * intact; the orchestrator only correlates the resulting run.
   */
  startFinalize(input: {
    projectId: string;
    runId: string;
    operationId: string;
    cardId: string;
    sessionId: string;
    workerKeyName: string | null;
  }): Promise<{ finalizeRunId: string }>;
}

export interface AutopilotSessionResult {
  committed: boolean;
  commitSha?: string | null;
  error?: string;
}

export type AutopilotFinalizeStatus = 'merged' | 'review_rejected' | 'ci_failed' | 'error';

export interface AutopilotFinalizeResult {
  status: AutopilotFinalizeStatus;
  mergedSha?: string | null;
  reviewStatus?: 'approved' | 'changes_requested' | null;
  message?: string;
}

export interface AutopilotReconcileInput<TResult> {
  operationId: string;
  fencingGeneration: number;
  result: TResult;
}

export interface AutopilotReconcileOutcome {
  /** True when this call moved the cycle forward (dispatched/settled + advanced). */
  advanced: boolean;
  /** True when the operation was already settled and this call was a no-op. */
  idempotent: boolean;
  outcome: 'succeeded' | 'failed' | 'rejected';
  snapshot: AutopilotRunSnapshot;
}

export interface AutopilotOrchestratorDeps {
  controller: AutopilotController;
  db: Database.Database;
  planner: AutopilotPlannerPort;
  board: AutopilotBoardPort;
  session: AutopilotSessionPort;
  finalize: AutopilotFinalizePort;
  randomId?: () => string;
}

function isSettled(op: AutopilotOperationRecord): boolean {
  return op.status !== 'pending' && op.status !== 'in_flight';
}

function outcomeFromOperation(op: AutopilotOperationRecord): 'succeeded' | 'failed' | 'rejected' {
  if (op.status === 'succeeded') return 'succeeded';
  return 'failed';
}

export class AutopilotOrchestrator {
  private readonly controller: AutopilotController;
  private readonly store: AutopilotStore;
  private readonly planner: AutopilotPlannerPort;
  private readonly board: AutopilotBoardPort;
  private readonly session: AutopilotSessionPort;
  private readonly finalize: AutopilotFinalizePort;

  constructor(deps: AutopilotOrchestratorDeps) {
    this.controller = deps.controller;
    this.store = new AutopilotStore(deps.db);
    this.planner = deps.planner;
    this.board = deps.board;
    this.session = deps.session;
    this.finalize = deps.finalize;
  }

  private requireActiveRunningCycle(projectId: string): {
    run: NonNullable<ReturnType<AutopilotStore['getActiveRun']>>;
    cycleId: string;
  } {
    const run = this.store.getActiveRun(projectId);
    if (!run) {
      throw new AutopilotError('no_active_run', 'No active Autopilot run');
    }
    if (run.controlState !== 'running') {
      throw new AutopilotError('conflict', `Run is ${run.controlState}, not running`);
    }
    const cycle = this.store.getCycle(run.id, run.cycleNumber);
    if (!cycle || cycle.status !== 'active') {
      throw new AutopilotError('conflict', 'No active cycle');
    }
    return { run, cycleId: cycle.id };
  }

  /**
   * Planning stage: choose and persist the baseline spec BEFORE filing any
   * work, then create the linked epic/phase/cards + blockers under a stable
   * board identity, validate the saved dependency order, settle the planning
   * operation and advance to implementing.
   *
   * The chosen spec is persisted before board creation so a board/validation
   * failure never strands filed work without a recorded decision, and a retry
   * reuses the persisted spec instead of re-expanding the brief into different
   * decisions. If a prior planning operation already succeeded but the run
   * crashed before advancing, this reconciles the missing advance forward
   * rather than re-planning.
   */
  async runPlanning(projectId: string): Promise<AutopilotRunSnapshot> {
    const { run, cycleId } = this.requireActiveRunningCycle(projectId);
    if (run.stage !== 'planning') {
      return this.controller.getRun(projectId, run.id);
    }
    // Recovery: a planning operation already succeeded for this cycle but the
    // run stopped before advancing. Reconcile the advance instead of replanning.
    const planningSucceeded = this.store
      .listStages(cycleId)
      .some((s) => s.stage === 'planning' && s.status === 'succeeded');
    if (planningSucceeded) {
      return this.controller.advanceStage(projectId, 'implementing');
    }
    if (!run.briefId) {
      throw new AutopilotError('invalid_config', 'run has no brief to plan from');
    }
    const brief = this.store.getBrief(run.briefId);
    if (!brief) {
      throw new AutopilotError('not_found', 'brief not found for run');
    }
    const cycle = this.store.getCycle(run.id, run.cycleNumber)!;

    // Claim exclusive planning execution BEFORE invoking the planner. A
    // concurrent runPlanning call sees the stage already in_progress and backs
    // off, so two callers cannot both expand the brief and overwrite each
    // other's decisions.
    const op = this.controller.claimPlanningOperation(projectId);
    if (!op) {
      return this.controller.getRun(projectId, run.id);
    }

    // Choose or reuse the spec and persist the chosen decisions before filing
    // any work. On a retry the persisted spec is reused verbatim. Every write
    // and side effect is guarded against superseded work (a generation bump,
    // pause/stop, or the operation no longer being the live claim).
    let spec: AutopilotBaselineSpec;
    try {
      if (cycle.specRevision != null && brief.spec_json) {
        spec = JSON.parse(brief.spec_json) as AutopilotBaselineSpec;
      } else {
        spec = await this.planner.expandBrief({
          projectId,
          runId: run.id,
          brief: brief.content,
          briefRevision: brief.revision,
        });
        if (!this.operationOwnsCurrentStage(op)) {
          return this.controller.getRun(projectId, run.id);
        }
        this.store.updateBriefSpec(run.briefId, JSON.stringify(spec));
        this.store.updateCycle(cycleId, { specRevision: brief.revision });
      }
    } catch (err) {
      await this.settleFailureQuiet(op, err);
      return this.controller.getRun(projectId, run.id);
    }

    // File the linked work under a stable board identity, then validate order.
    let board: AutopilotPlannedBoard;
    try {
      if (!this.operationOwnsCurrentStage(op)) {
        return this.controller.getRun(projectId, run.id);
      }
      board = await this.board.createBaselineBoard({
        projectId,
        runId: run.id,
        idempotencyKey: `autopilot:${run.id}:cycle-${cycle.cycleNumber}`,
        spec,
      });
      const ordering = await this.board.validatePhaseOrder({ projectId, epicId: board.epicId });
      if (!ordering.ok) {
        throw new AutopilotError(
          'invalid_config',
          `phase dependency order is invalid: ${ordering.reason ?? 'unknown'}`,
        );
      }
    } catch (err) {
      await this.settleFailureQuiet(op, err);
      return this.controller.getRun(projectId, run.id);
    }

    if (!this.operationOwnsCurrentStage(op)) {
      return this.controller.getRun(projectId, run.id);
    }
    this.store.updateCycle(cycleId, { cardId: board.primaryCardId });
    try {
      await this.controller.completeOperation({
        operationId: op.id,
        fencingGeneration: op.fencingGeneration,
        outcome: 'succeeded',
        result: {
          specRevision: brief.revision,
          epicId: board.epicId,
          primaryCardId: board.primaryCardId,
          cardIds: board.cards.map((c) => c.cardId),
        },
      });
    } catch (err) {
      if (this.isSupersededError(err)) {
        return this.controller.getRun(projectId, run.id);
      }
      throw err;
    }

    const settled = this.store.getRun(run.id);
    if (settled && settled.controlState === 'running' && settled.stage === 'planning') {
      return this.controller.advanceStage(projectId, 'implementing');
    }
    return this.controller.getRun(projectId, run.id);
  }

  /**
   * Implementing stage: reserve a guarded controller operation BEFORE the
   * external session launch, then dispatch a bounded session keyed on that
   * operation's durable id and record it against the cycle. Reserving first is
   * both crash-safe (a launched session is always tracked by an operation) and
   * concurrency-safe (the reservation is synchronous, so a second concurrent
   * call sees the in-flight operation and deduplicates instead of launching a
   * second session). Idempotent: an already-reserved cycle returns that op.
   */
  async dispatchImplementation(projectId: string): Promise<AutopilotOperationRecord> {
    const { run, cycleId } = this.requireActiveRunningCycle(projectId);
    if (run.stage !== 'implementing') {
      throw new AutopilotError('conflict', `Run stage is ${run.stage}, not implementing`);
    }
    const existing = this.findInFlightOperation(run.id, 'implement', cycleId);
    if (existing) return existing;
    const cycle = this.store.getCycle(run.id, run.cycleNumber)!;
    if (!cycle.cardId) {
      throw new AutopilotError('invalid_config', 'cycle has no card to implement');
    }
    const spec = this.readSpec(run.briefId);
    const op = await this.controller.beginOperation({
      projectId,
      kind: 'implement',
      intent: { cardId: cycle.cardId },
    });
    try {
      const dispatched = await this.session.dispatchImplementation({
        projectId,
        runId: run.id,
        operationId: op.id,
        cardId: cycle.cardId,
        workerKeyName: run.workerAuthority.keyName,
        bounds: { maxStageTimeoutMs: run.limits.maxStageTimeoutMs },
        context: {
          specRevision: cycle.specRevision,
          cardId: cycle.cardId,
          acceptanceJourneys: spec?.acceptanceJourneys ?? [],
          nonGoals: spec?.nonGoals ?? [],
          specDecisions: spec?.specDecisions ?? [],
        },
      });
      return this.persistDispatchOrDisown(op, cycleId, 'implementation', {
        sessionId: dispatched.sessionId,
      });
    } catch (err) {
      await this.settleFailureQuiet(op, err);
      throw err;
    }
  }

  /**
   * Settle an implementation session. A committed session advances to
   * finalizing; a non-committed one fails the operation (controller retries or
   * pauses). Presence of a callback alone never advances — the session must
   * report a local commit. A duplicate or post-crash callback for an already
   * succeeded operation reconciles the forward advance rather than dropping it.
   */
  async reconcileImplementation(
    projectId: string,
    input: AutopilotReconcileInput<AutopilotSessionResult>,
  ): Promise<AutopilotReconcileOutcome> {
    const op = this.requireOperationOfKind(input.operationId, 'implement');
    const runId = op.runId;

    if (isSettled(op)) {
      if (op.status === 'succeeded') {
        const fwd = this.advanceAfterImplement(projectId, op);
        return {
          advanced: fwd.advanced,
          idempotent: true,
          outcome: 'succeeded',
          snapshot: fwd.snapshot,
        };
      }
      return {
        advanced: false,
        idempotent: true,
        outcome: outcomeFromOperation(op),
        snapshot: this.controller.getRun(projectId, runId),
      };
    }

    if (!input.result.committed) {
      await this.controller.completeOperation({
        operationId: input.operationId,
        fencingGeneration: input.fencingGeneration,
        outcome: 'failed',
        result: { error: input.result.error ?? 'session did not commit' },
      });
      return {
        advanced: false,
        idempotent: false,
        outcome: 'failed',
        snapshot: this.controller.getRun(projectId, runId),
      };
    }

    await this.controller.completeOperation({
      operationId: input.operationId,
      fencingGeneration: input.fencingGeneration,
      outcome: 'succeeded',
      result: { commitSha: input.result.commitSha ?? null },
    });
    const settled = this.store.getOperation(input.operationId)!;
    const fwd = this.advanceAfterImplement(projectId, settled);
    return {
      advanced: fwd.advanced,
      idempotent: false,
      outcome: 'succeeded',
      snapshot: fwd.snapshot,
    };
  }

  /**
   * Finalizing stage: reserve a guarded operation BEFORE invoking Finalize,
   * then start it under the run's scoped identity keyed on the operation id so
   * a repeated call cannot start a second shipping workflow. Leaves the
   * operation in flight for {@link reconcileFinalize}.
   */
  async dispatchFinalize(projectId: string): Promise<AutopilotOperationRecord> {
    const { run, cycleId } = this.requireActiveRunningCycle(projectId);
    if (run.stage !== 'finalizing') {
      throw new AutopilotError('conflict', `Run stage is ${run.stage}, not finalizing`);
    }
    const existing = this.findInFlightOperation(run.id, 'finalize', cycleId);
    if (existing) return existing;
    const cycle = this.store.getCycle(run.id, run.cycleNumber)!;
    if (!cycle.cardId || !cycle.sessionId) {
      throw new AutopilotError('invalid_config', 'cycle is missing card or session for Finalize');
    }
    const op = await this.controller.beginOperation({
      projectId,
      kind: 'finalize',
      intent: { cardId: cycle.cardId, sessionId: cycle.sessionId },
    });
    try {
      const started = await this.finalize.startFinalize({
        projectId,
        runId: run.id,
        operationId: op.id,
        cardId: cycle.cardId,
        sessionId: cycle.sessionId,
        workerKeyName: run.workerAuthority.keyName,
      });
      return this.persistDispatchOrDisown(op, cycleId, 'Finalize', {
        finalizeRunId: started.finalizeRunId,
      });
    } catch (err) {
      await this.settleFailureQuiet(op, err);
      throw err;
    }
  }

  /**
   * Settle a Finalize run. Only a `merged` result carrying a real merged SHA
   * and an approved review advances the cycle (records the tested/merged SHA);
   * review rejection, CI failure, an error, or a missing SHA fails the
   * operation so nothing merges the run's work implicitly. The merged SHA is
   * stored on the durable operation result and reconciled onto the cycle, so a
   * crash between settlement and the cycle write is recovered by a repeated
   * callback rather than losing the SHA.
   */
  async reconcileFinalize(
    projectId: string,
    input: AutopilotReconcileInput<AutopilotFinalizeResult>,
  ): Promise<AutopilotReconcileOutcome> {
    const op = this.requireOperationOfKind(input.operationId, 'finalize');
    const runId = op.runId;

    if (isSettled(op)) {
      if (op.status === 'succeeded') {
        const changed = this.persistMergedShaFromOp(op);
        return {
          advanced: changed,
          idempotent: true,
          outcome: 'succeeded',
          snapshot: this.controller.getRun(projectId, runId),
        };
      }
      return {
        advanced: false,
        idempotent: true,
        outcome: 'rejected',
        snapshot: this.controller.getRun(projectId, runId),
      };
    }

    const merged =
      input.result.status === 'merged' &&
      typeof input.result.mergedSha === 'string' &&
      input.result.mergedSha.trim().length > 0 &&
      input.result.reviewStatus === 'approved';

    if (!merged) {
      await this.controller.completeOperation({
        operationId: input.operationId,
        fencingGeneration: input.fencingGeneration,
        outcome: 'failed',
        result: {
          status: input.result.status,
          reviewStatus: input.result.reviewStatus ?? null,
          message: input.result.message ?? null,
        },
      });
      return {
        advanced: false,
        idempotent: false,
        outcome: 'rejected',
        snapshot: this.controller.getRun(projectId, runId),
      };
    }

    await this.controller.completeOperation({
      operationId: input.operationId,
      fencingGeneration: input.fencingGeneration,
      outcome: 'succeeded',
      result: { mergedSha: input.result.mergedSha },
    });
    const settled = this.store.getOperation(input.operationId)!;
    const changed = this.persistMergedShaFromOp(settled);
    return {
      advanced: changed,
      idempotent: false,
      outcome: 'succeeded',
      snapshot: this.controller.getRun(projectId, runId),
    };
  }

  /**
   * Apply the implement stage's forward transition (advance to finalizing).
   * Keyed on the specific operation, not the run's current stage: it advances
   * only when the operation belongs to the run's ACTIVE cycle, matches the
   * current fencing generation, succeeded, and is linked to that cycle's
   * succeeded implementing stage. This prevents a delayed callback from an
   * earlier cycle (or a superseded generation) advancing a later cycle's
   * freshly-opened implementing stage before its own work is dispatched.
   */
  private advanceAfterImplement(
    projectId: string,
    op: AutopilotOperationRecord,
  ): { advanced: boolean; snapshot: AutopilotRunSnapshot } {
    const runId = op.runId;
    const stay = (): { advanced: boolean; snapshot: AutopilotRunSnapshot } => ({
      advanced: false,
      snapshot: this.controller.getRun(projectId, runId),
    });
    const run = this.store.getRun(runId);
    if (!run || run.controlState !== 'running' || run.stage !== 'implementing') return stay();
    if (op.status !== 'succeeded' || op.fencingGeneration !== run.fencingGeneration) return stay();
    const cycle = this.store.getCycle(run.id, run.cycleNumber);
    if (!cycle || cycle.id !== op.cycleId) return stay(); // cross-cycle / stale callback
    const stage = this.store.getStageByOperationId(op.id);
    if (
      !stage ||
      stage.cycleId !== cycle.id ||
      stage.stage !== 'implementing' ||
      stage.status !== 'succeeded'
    ) {
      return stay();
    }
    return { advanced: true, snapshot: this.controller.advanceStage(projectId, 'finalizing') };
  }

  /**
   * Reconcile the merged SHA from a succeeded Finalize operation's durable
   * result onto its cycle. Returns true only when it wrote a missing SHA, so a
   * duplicate callback is a no-op and the recorded SHA never changes.
   */
  private persistMergedShaFromOp(op: AutopilotOperationRecord): boolean {
    if (!op.cycleId) return false;
    const sha = (op.result as { mergedSha?: unknown } | null)?.mergedSha;
    if (typeof sha !== 'string' || !sha) return false;
    const cycle = this.store.getCycleById(op.cycleId);
    if (cycle && !cycle.testedCommitSha) {
      this.store.updateCycle(op.cycleId, { testedCommitSha: sha });
      return true;
    }
    return false;
  }

  private readSpec(briefId: string | null): AutopilotBaselineSpec | null {
    if (!briefId) return null;
    const brief = this.store.getBrief(briefId);
    if (!brief?.spec_json) return null;
    try {
      return JSON.parse(brief.spec_json) as AutopilotBaselineSpec;
    } catch {
      return null;
    }
  }

  /** Find an in-flight operation of `kind` scoped to a specific cycle. */
  private findInFlightOperation(
    runId: string,
    kind: string,
    cycleId: string,
  ): AutopilotOperationRecord | null {
    return (
      this.store
        .listInFlightOperations(runId)
        .find((op) => op.kind === kind && op.cycleId === cycleId) ?? null
    );
  }

  /** Load an operation and assert it is of the expected kind. */
  private requireOperationOfKind(operationId: string, kind: string): AutopilotOperationRecord {
    const op = this.store.getOperation(operationId);
    if (!op) throw new AutopilotError('not_found', 'Operation not found');
    if (op.kind !== kind) {
      throw new AutopilotError('conflict', `Operation ${operationId} is not a ${kind} operation`);
    }
    return op;
  }

  /**
   * True while `op` still owns the active cycle's current in-progress stage:
   * the operation is still in flight, the run is running at the operation's
   * fencing generation, the operation belongs to the run's active cycle, and
   * the stage linked to it is still in_progress. Any post-await persistence or
   * advancement must gate on this so a superseded/timed-out launch (whose
   * response resolves late, after a retry has taken over) cannot overwrite the
   * current cycle's associations or advance a stage it no longer owns.
   */
  private operationOwnsCurrentStage(op: AutopilotOperationRecord): boolean {
    const current = this.store.getOperation(op.id);
    if (!current || current.status !== 'in_flight') return false;
    const run = this.store.getRun(op.runId);
    if (!run || run.controlState !== 'running' || run.fencingGeneration !== op.fencingGeneration) {
      return false;
    }
    const cycle = this.store.getCycle(run.id, run.cycleNumber);
    if (!cycle || cycle.id !== current.cycleId) return false;
    const stage = this.store.getStageByOperationId(op.id);
    return !!stage && stage.cycleId === cycle.id && stage.status === 'in_progress';
  }

  private isSupersededError(err: unknown): boolean {
    return isAutopilotError(err) && (err.code === 'stale_generation' || err.code === 'conflict');
  }

  /**
   * Persist a dispatch response's external ref (sessionId / finalizeRunId).
   * The ref is always recorded on the operation itself (so cancellation can
   * still reach a launch that resolved late), but the current cycle association
   * is only written when the operation STILL owns the active cycle's in-progress
   * stage. A superseded/timed-out launch whose response resolves after a retry
   * has taken over is disowned (throws) instead of clobbering the live retry's
   * cycle.sessionId / cycle.finalizeRunId.
   */
  private persistDispatchOrDisown(
    op: AutopilotOperationRecord,
    cycleId: string,
    kind: string,
    ref: { sessionId: string } | { finalizeRunId: string },
  ): AutopilotOperationRecord {
    this.store.updateOperation(op.id, { ...ref, updatedAt: op.createdAt });
    if (!this.operationOwnsCurrentStage(op)) {
      throw new AutopilotError('conflict', `${kind} dispatch was superseded before it completed`);
    }
    this.store.updateCycle(cycleId, ref);
    return this.store.getOperation(op.id)!;
  }

  /** Settle an operation failed, tolerating a superseded operation (best effort). */
  private async settleFailureQuiet(op: AutopilotOperationRecord, err: unknown): Promise<void> {
    try {
      await this.settleFailure(op, err);
    } catch (settleErr) {
      if (!this.isSupersededError(settleErr)) throw settleErr;
    }
  }

  private async settleFailure(op: AutopilotOperationRecord, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    await this.controller.completeOperation({
      operationId: op.id,
      fencingGeneration: op.fencingGeneration,
      outcome: 'failed',
      result: { error: message },
    });
  }
}

export function createAutopilotOrchestrator(
  deps: AutopilotOrchestratorDeps,
): AutopilotOrchestrator {
  return new AutopilotOrchestrator(deps);
}
