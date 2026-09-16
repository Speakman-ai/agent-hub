import type Database from 'better-sqlite3';
import { readFileSync, statSync } from 'fs';
import { extname } from 'path';
import { AutopilotError, isAutopilotError } from './errors.js';
import { AutopilotStore } from './store.js';
import { assessStorageRecoverability, type AutopilotStorageRecoveryKind } from './local-target.js';
import type { AutopilotController } from './controller.js';
import type { AutopilotOperationRecord, AutopilotRunSnapshot } from './types.js';
import {
  deriveCycleJourneys,
  judgeEvaluation,
  parseCycleVerification,
  pinCriteriaFromSpec,
  stampHubEvidence,
  writeCycleVerification,
  type ArtifactExists,
  type AutopilotEvaluationJudgement,
  type AutopilotEvaluationReport,
  type AutopilotExecutionCapture,
  type AutopilotPinnedCriteria,
  type AutopilotPinnedCriterion,
} from './evaluate.js';
import {
  buildDocumentationPages,
  buildStructuredCycleRecord,
  createMemoryDocumentPort,
  currentVerifiedRecord,
  parseCycleDocumentation,
  reconstructHandoff,
  redactAutopilotValue,
  redactCycleRecord,
} from './document.js';
import type {
  AutopilotDocumentPort,
  AutopilotEvidenceArtifact,
  AutopilotFailedAttempt,
  AutopilotSessionHandoff,
  AutopilotStructuredCycleRecord,
} from './document.js';
import {
  AUTOPILOT_NO_BENEFIT_PAUSE_STREAK,
  applyPlannerProposal,
  consecutiveNoBenefitStreak,
  extraProtectedJourneys,
  mergeInScopeSpecDecisions,
  parseSelectedImprovementRecord,
  rankImprovementCandidates,
  serializeSelectedImprovement,
  type AutopilotImprovementProposal,
  type AutopilotSelectedImprovement,
} from './select.js';

export type {
  AutopilotDocumentPort,
  AutopilotSessionHandoff,
  AutopilotStructuredCycleRecord,
} from './document.js';

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
  /**
   * Explicit storage recovery contract. Deploy is allowed only for
   * `disposable` or `backward-compatible`, including the first cycle.
   */
  storageRecovery: AutopilotStorageRecoveryKind;
  qualityRubricVersion: number;
}

export interface AutopilotPlannerInput {
  projectId: string;
  runId: string;
  brief: string;
  briefRevision: number;
}

export interface AutopilotImprovementPlannerInput {
  projectId: string;
  runId: string;
  cycleNumber: number;
  brief: string;
  briefRevision: number;
  spec: AutopilotBaselineSpec;
  ranked: AutopilotSelectedImprovement[];
  lastVerification: unknown;
  failedAttempts: AutopilotFailedAttempt[];
  priorImprovements: AutopilotSelectedImprovement[];
}

export interface AutopilotPlannerPort {
  /**
   * Expand a loose brief into a concrete baseline. The planner may lock real
   * spec decisions but must not expand scope or permissions; callers treat a
   * thrown error as a planning failure (retryable by the controller).
   */
  expandBrief(input: AutopilotPlannerInput): Promise<AutopilotBaselineSpec>;
  /**
   * Rank or confirm a bounded improvement set. Hub re-validates the result
   * against the frozen brief, non-goals, and baseline coverage.
   */
  proposeImprovements?(
    input: AutopilotImprovementPlannerInput,
  ): Promise<AutopilotImprovementProposal>;
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
  /**
   * True when every card in every predecessor phase is Done, including epic
   * cards that still have no phase. Pass the next cycle's `idempotencyKey`
   * so recovery excludes that cycle's own phase (empty or To Do) and still
   * checks all earlier phases, not only the nearest.
   */
  priorPhaseComplete(input: {
    projectId: string;
    epicId: string;
    idempotencyKey?: string;
  }): Promise<{ ok: boolean; reason?: string }>;
  /**
   * File the next cycle's phase + card on the existing epic. Idempotent per
   * `idempotencyKey` (phase key and improvement card). Callers persist the
   * selected proposal before this write and validate phase order after it
   * returns.
   */
  createImprovementBoard(input: {
    projectId: string;
    runId: string;
    epicId: string;
    idempotencyKey: string;
    improvement: AutopilotSelectedImprovement;
    blockedByCardIds: string[];
    specDecisions: { key: string; decision: string }[];
  }): Promise<AutopilotPlannedBoard>;
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
  storageRecovery: AutopilotStorageRecoveryKind | null;
  /** Reconstructed from saved cycle records so a restart does not need live chat. */
  priorHandoff: AutopilotSessionHandoff | null;
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

export interface AutopilotDeployPort {
  /**
   * Deploy `sha` to the run's opted-in experiment target. `operationId` keys
   * the launch so a retry cannot start a second pipeline. Approval bypass
   * applies only to that target.
   */
  deployRevision(input: {
    projectId: string;
    runId: string;
    operationId: string;
    targetId: string;
    sha: string;
    workerKeyName: string | null;
  }): Promise<{ deploymentId: string }>;
  /**
   * Redeploy the last verified artifact. Awaited to a terminal outcome so
   * the orchestrator can pause immediately on recovery failure.
   */
  rollback(input: {
    projectId: string;
    runId: string;
    operationId: string;
    targetId: string;
    priorDeploymentId: string;
    priorSha: string;
  }): Promise<AutopilotDeployResult>;
}

export type AutopilotDeployStatus = 'success' | 'error' | 'cancelled' | 'awaiting_approval';

export interface AutopilotDeployResult {
  status: AutopilotDeployStatus;
  deploymentId: string;
  deployedSha?: string | null;
  message?: string;
}

export interface AutopilotEvaluatePort {
  /**
   * Start a bounded evaluator session with no implementation write authority.
   * The worker hits the actual local target (not session preview) and must
   * return structured criterion evidence. `operationId` keys the launch.
   */
  dispatchEvaluation(input: {
    projectId: string;
    runId: string;
    operationId: string;
    deploymentId: string;
    origin: string;
    expectedSha: string;
    pinned: AutopilotPinnedCriteria;
    workerKeyName: string | null;
    bounds: AutopilotSessionBounds;
  }): Promise<{ sessionId: string }>;
}

export interface AutopilotReconcileInput<TResult> {
  operationId: string;
  fencingGeneration: number;
  result: TResult;
  /** Hub-recorded captures. Never derived from `result`. */
  captures?: AutopilotExecutionCapture[];
}

export type AutopilotProbeApi = (input: {
  operationId: string;
  deploymentId: string;
  expectedSha: string;
  origin: string;
  criterion: AutopilotPinnedCriterion;
}) => Promise<AutopilotExecutionCapture | null>;

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
  deploy: AutopilotDeployPort;
  evaluate: AutopilotEvaluatePort;
  document?: AutopilotDocumentPort;
  randomId?: () => string;
  /** Hub-side artifact existence and mtime. Tests inject; production stats. */
  artifactExists?: ArtifactExists;
  /** Read screenshot/trace bytes for artifact publication. Tests inject. */
  readEvidenceFile?: AutopilotReadEvidenceFile;
  /** Load captures Hub recorded during this evaluate operation. */
  listCaptures?: (operationId: string) => AutopilotExecutionCapture[];
  /** Hub-executed API probe; never copies status from the evaluator report. */
  probeApi?: AutopilotProbeApi;
}

export type AutopilotReadEvidenceFile = (filePath: string) => {
  body: Buffer;
  contentType: string;
} | null;

function defaultReadEvidenceFile(filePath: string): {
  body: Buffer;
  contentType: string;
} | null {
  try {
    return { body: readFileSync(filePath), contentType: contentTypeForEvidencePath(filePath) };
  } catch {
    return null;
  }
}

function contentTypeForEvidencePath(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.json') return 'application/json';
  return 'application/octet-stream';
}

function defaultArtifactExists(filePath: string): { exists: boolean; mtimeMs?: number } {
  try {
    const st = statSync(filePath);
    return { exists: true, mtimeMs: st.mtimeMs };
  } catch {
    return { exists: false };
  }
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
  private readonly deploy: AutopilotDeployPort;
  private readonly evaluate: AutopilotEvaluatePort;
  private readonly document: AutopilotDocumentPort;
  private readonly artifactExists: ArtifactExists;
  private readonly readEvidenceFile: AutopilotReadEvidenceFile;
  private readonly listCaptures: (operationId: string) => AutopilotExecutionCapture[];
  private readonly probeApi: AutopilotProbeApi | null;

  constructor(deps: AutopilotOrchestratorDeps) {
    this.controller = deps.controller;
    this.store = new AutopilotStore(deps.db);
    this.planner = deps.planner;
    this.board = deps.board;
    this.session = deps.session;
    this.finalize = deps.finalize;
    this.deploy = deps.deploy;
    this.evaluate = deps.evaluate;
    this.document = deps.document ?? createMemoryDocumentPort();
    this.artifactExists = deps.artifactExists ?? defaultArtifactExists;
    this.readEvidenceFile = deps.readEvidenceFile ?? defaultReadEvidenceFile;
    this.listCaptures = deps.listCaptures ?? (() => []);
    this.probeApi = deps.probeApi ?? null;
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
    this.store.updateCycle(cycleId, {
      cardId: board.primaryCardId,
      verificationJson: writeCycleVerification(cycle.verification, {
        pinned: pinCriteriaFromSpec(
          spec,
          brief.revision,
          deriveCycleJourneys(
            spec,
            { cardId: board.primaryCardId, selectedImprovement: cycle.selectedImprovement },
            board,
          ),
        ),
      }),
    });
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
          storageRecovery: spec?.storageRecovery ?? null,
          priorHandoff: reconstructHandoff({
            cycles: this.store.listCyclesForProject(projectId).filter((c) => c.id !== cycle.id),
            spec,
            lastVerifiedSha: run.lastVerifiedSha,
            lastDeploymentId: run.lastDeploymentId,
          }),
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
      await this.afterFailedOperation(projectId, this.store.getOperation(input.operationId)!);
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
        this.persistMergedShaFromOp(op);
        const fwd = this.advanceAfterFinalize(projectId, op);
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
      await this.afterFailedOperation(projectId, this.store.getOperation(input.operationId)!);
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
    this.persistMergedShaFromOp(settled);
    const fwd = this.advanceAfterFinalize(projectId, settled);
    return {
      advanced: fwd.advanced,
      idempotent: false,
      outcome: 'succeeded',
      snapshot: fwd.snapshot,
    };
  }

  /**
   * Deploying stage: reserve a guarded operation BEFORE triggering deploy of
   * the exact merged SHA, then start it keyed on the operation id. Duplicate
   * in-flight deploys for this cycle are reused. Pauses without launching when
   * storage is not recoverable.
   */
  async dispatchDeploy(projectId: string): Promise<AutopilotOperationRecord> {
    const { run, cycleId } = this.requireActiveRunningCycle(projectId);
    if (run.stage !== 'deploying') {
      throw new AutopilotError('conflict', `Run stage is ${run.stage}, not deploying`);
    }
    const existing = this.findInFlightOperation(run.id, 'deploy', cycleId);
    if (existing) return existing;
    const cycle = this.store.getCycle(run.id, run.cycleNumber)!;
    const sha = cycle.testedCommitSha;
    if (!sha) {
      throw new AutopilotError('invalid_config', 'cycle has no merged SHA to deploy');
    }
    if (!run.targetId) {
      throw new AutopilotError('invalid_config', 'run has no experiment target');
    }
    const recover = assessStorageRecoverability(this.readSpec(run.briefId));
    const op = await this.controller.beginOperation({
      projectId,
      kind: 'deploy',
      intent: { sha, targetId: run.targetId },
    });
    if (!recover.ok) {
      await this.controller.completeOperation({
        operationId: op.id,
        fencingGeneration: op.fencingGeneration,
        outcome: 'failed',
        haltReason: recover.reason,
        result: { error: recover.reason },
      });
      await this.afterFailedOperation(projectId, this.store.getOperation(op.id)!);
      return this.store.getOperation(op.id)!;
    }
    try {
      const started = await this.deploy.deployRevision({
        projectId,
        runId: run.id,
        operationId: op.id,
        targetId: run.targetId,
        sha,
        workerKeyName: run.workerAuthority.keyName,
      });
      return this.persistDispatchOrDisown(op, cycleId, 'deployment', {
        deploymentId: started.deploymentId,
      });
    } catch (err) {
      await this.settleFailureQuiet(op, err);
      throw err;
    }
  }

  /**
   * Settle a candidate deploy. Only an exact match of the merged SHA at the
   * live target advances to verifying. A failed or mismatched candidate rolls
   * back to the last verified artifact (or pauses when there is none / rollback
   * fails). Does not write lastVerifiedSha: a failed candidate cannot become
   * last-known-good.
   */
  async reconcileDeploy(
    projectId: string,
    input: AutopilotReconcileInput<AutopilotDeployResult>,
  ): Promise<AutopilotReconcileOutcome> {
    const op = this.requireOperationOfKind(input.operationId, 'deploy');
    const runId = op.runId;
    if (isSettled(op)) {
      if (op.status === 'succeeded') {
        const fwd = this.advanceAfterDeploy(projectId, op);
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

    const run = this.store.getRun(runId);
    const intended =
      typeof (op.intent as { sha?: unknown } | null)?.sha === 'string'
        ? ((op.intent as { sha: string }).sha as string)
        : (this.store.getCycleById(op.cycleId ?? '')?.testedCommitSha ?? null);
    const exact =
      input.result.status === 'success' &&
      typeof input.result.deployedSha === 'string' &&
      input.result.deployedSha.trim().length > 0 &&
      intended != null &&
      input.result.deployedSha === intended;

    if (exact) {
      await this.controller.completeOperation({
        operationId: input.operationId,
        fencingGeneration: input.fencingGeneration,
        outcome: 'succeeded',
        result: {
          deployedSha: input.result.deployedSha,
          deploymentId: input.result.deploymentId,
        },
      });
      const settled = this.store.getOperation(input.operationId)!;
      if (settled.cycleId) {
        this.store.updateCycle(settled.cycleId, { deploymentId: input.result.deploymentId });
      }
      const fwd = this.advanceAfterDeploy(projectId, settled);
      return {
        advanced: fwd.advanced,
        idempotent: false,
        outcome: 'succeeded',
        snapshot: fwd.snapshot,
      };
    }

    if (input.result.status === 'awaiting_approval') {
      await this.controller.completeOperation({
        operationId: input.operationId,
        fencingGeneration: input.fencingGeneration,
        outcome: 'failed',
        haltReason: 'experiment target required approval; unattended deploy is not authorized',
        result: { status: input.result.status, message: input.result.message ?? null },
      });
      await this.afterFailedOperation(projectId, this.store.getOperation(input.operationId)!);
      return {
        advanced: false,
        idempotent: false,
        outcome: 'failed',
        snapshot: this.controller.getRun(projectId, runId),
      };
    }

    return this.recoverFailedCandidate(projectId, op, input, run);
  }

  /**
   * Redeploy the last verified artifact after a failed candidate. Pauses
   * when there is no last-known-good or rollback does not restore that SHA.
   */
  private async recoverFailedCandidate(
    projectId: string,
    op: AutopilotOperationRecord,
    input: AutopilotReconcileInput<AutopilotDeployResult>,
    run: ReturnType<AutopilotStore['getRun']>,
  ): Promise<AutopilotReconcileOutcome> {
    const fail = async (haltReason: string, extra: Record<string, unknown> = {}) => {
      await this.controller.completeOperation({
        operationId: input.operationId,
        fencingGeneration: input.fencingGeneration,
        outcome: 'failed',
        haltReason,
        result: {
          status: input.result.status,
          deployedSha: input.result.deployedSha ?? null,
          message: input.result.message ?? null,
          ...extra,
        },
      });
      await this.afterFailedOperation(projectId, this.store.getOperation(input.operationId)!);
      return {
        advanced: false,
        idempotent: false,
        outcome: 'failed' as const,
        snapshot: this.controller.getRun(projectId, op.runId),
      };
    };
    if (!run || !run.lastVerifiedSha || !run.lastDeploymentId || !run.targetId) {
      return fail('no last-known-good to recover');
    }
    let rolled: AutopilotDeployResult;
    try {
      rolled = await this.deploy.rollback({
        projectId,
        runId: run.id,
        operationId: op.id,
        targetId: run.targetId,
        priorDeploymentId: run.lastDeploymentId,
        priorSha: run.lastVerifiedSha,
      });
    } catch (err) {
      return fail('rollback failed', {
        rollbackError: err instanceof Error ? err.message : String(err),
      });
    }
    if (rolled.status !== 'success' || rolled.deployedSha !== run.lastVerifiedSha) {
      return fail('rollback failed', {
        rollbackStatus: rolled.status,
        restoredSha: rolled.deployedSha ?? null,
      });
    }
    if (op.cycleId) {
      this.store.updateCycle(op.cycleId, { deploymentId: input.result.deploymentId });
    }
    return fail('candidate deploy failed; recovered last-known-good', {
      restoredSha: rolled.deployedSha,
      rollbackDeploymentId: rolled.deploymentId,
    });
  }

  /**
   * Apply the finalize stage's forward transition (advance to deploying).
   */
  private advanceAfterFinalize(
    projectId: string,
    op: AutopilotOperationRecord,
  ): { advanced: boolean; snapshot: AutopilotRunSnapshot } {
    return this.advanceAfterStage(projectId, op, 'finalizing', 'deploying');
  }

  /**
   * Apply the deploy stage's forward transition (advance to verifying).
   */
  private advanceAfterDeploy(
    projectId: string,
    op: AutopilotOperationRecord,
  ): { advanced: boolean; snapshot: AutopilotRunSnapshot } {
    return this.advanceAfterStage(projectId, op, 'deploying', 'verifying');
  }

  /**
   * Verifying stage: dispatch a separate evaluator session (consult / no
   * implementation write) against the live local target. Criteria were pinned
   * at planning; the expected SHA is the merged tested commit.
   */
  async dispatchEvaluate(projectId: string): Promise<AutopilotOperationRecord> {
    const { run, cycleId } = this.requireActiveRunningCycle(projectId);
    if (run.stage !== 'verifying') {
      throw new AutopilotError('conflict', `Run stage is ${run.stage}, not verifying`);
    }
    const existing = this.findInFlightOperation(run.id, 'evaluate', cycleId);
    if (existing) return existing;
    const cycle = this.store.getCycle(run.id, run.cycleNumber)!;
    const expectedSha = cycle.testedCommitSha?.trim() ?? '';
    if (!expectedSha) {
      throw new AutopilotError('invalid_config', 'cycle has no tested commit SHA to evaluate');
    }
    const origin = this.requireTargetOrigin(run.targetId, projectId);
    const pinned = parseCycleVerification(cycle.verification).pinned;
    if (!pinned) {
      throw new AutopilotError(
        'invalid_config',
        'evaluation criteria were not pinned before implementation',
      );
    }
    const op = await this.controller.beginOperation({
      projectId,
      kind: 'evaluate',
      intent: { expectedSha, origin, specRevision: pinned.specRevision },
    });
    try {
      const dispatched = await this.evaluate.dispatchEvaluation({
        projectId,
        runId: run.id,
        operationId: op.id,
        deploymentId: cycle.deploymentId ?? '',
        origin,
        expectedSha,
        pinned,
        workerKeyName: run.workerAuthority.evaluatorKeyName ?? run.workerAuthority.keyName,
        bounds: { maxStageTimeoutMs: run.limits.maxStageTimeoutMs },
      });
      this.store.updateOperation(op.id, { sessionId: dispatched.sessionId });
      if (!this.operationOwnsCurrentStage(op)) {
        throw new AutopilotError(
          'conflict',
          'evaluate dispatch was superseded before it completed',
        );
      }
      return this.store.getOperation(op.id)!;
    } catch (err) {
      await this.settleFailureQuiet(op, err);
      throw err;
    }
  }

  /**
   * Hub captures recorded during this evaluate operation, plus optional
   * Hub-executed API probes for pinned api_check criteria that still lack a
   * requestId. The evaluator report is never a source of API status.
   */
  private async collectEvaluateCaptures(input: {
    operationId: string;
    deploymentId: string;
    expectedSha: string;
    origin: string;
    pinned: AutopilotPinnedCriteria | null;
    extra: AutopilotExecutionCapture[];
  }): Promise<AutopilotExecutionCapture[]> {
    const captures = [...this.listCaptures(input.operationId), ...input.extra];
    if (!this.probeApi || !input.pinned) return captures;
    for (const criterion of input.pinned.criteria) {
      if (criterion.kind !== 'api_check') continue;
      if (captures.some((c) => c.criterionId === criterion.id && c.api?.requestId)) continue;
      const probed = await this.probeApi({
        operationId: input.operationId,
        deploymentId: input.deploymentId,
        expectedSha: input.expectedSha,
        origin: input.origin,
        criterion,
      });
      if (probed) captures.push(probed);
    }
    return captures;
  }

  /**
   * Settle an independent evaluation. Passing, artifact-backed evidence at
   * the expected SHA promotes last-known-good and advances to documenting.
   * Failed evaluation recovers the prior verified artifact and never opens
   * improvement selection.
   */
  async reconcileEvaluate(
    projectId: string,
    input: AutopilotReconcileInput<AutopilotEvaluationReport | null>,
  ): Promise<AutopilotReconcileOutcome> {
    const op = this.requireOperationOfKind(input.operationId, 'evaluate');
    const runId = op.runId;
    if (isSettled(op)) {
      if (op.status === 'succeeded') {
        this.persistLastKnownGoodFromOp(projectId, op);
        const fwd = this.advanceAfterEvaluate(projectId, op);
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

    const run = this.store.getRun(runId);
    const cycle = op.cycleId ? this.store.getCycleById(op.cycleId) : null;
    const pinned = parseCycleVerification(cycle?.verification).pinned;
    const expectedSha = cycle?.testedCommitSha?.trim() ?? '';
    const origin = this.requireTargetOrigin(run?.targetId ?? null, projectId);
    const observedSha = this.controller.observeDeployedRevision(projectId, run?.targetId ?? null);
    const deploymentId = cycle?.deploymentId ?? '';
    const captures = await this.collectEvaluateCaptures({
      operationId: op.id,
      deploymentId,
      expectedSha,
      origin,
      pinned,
      extra: input.captures ?? [],
    });
    const hubEvidence = stampHubEvidence({
      operationId: op.id,
      deploymentId,
      expectedSha,
      observedSha,
      origin,
      operationStartedAt: op.createdAt,
      captures,
      report: input.result,
      artifactExists: this.artifactExists,
    });
    const judgement = judgeEvaluation({
      pinned,
      expectedSha,
      targetOrigin: origin,
      report: input.result,
      hubEvidence,
      binding: { operationId: op.id, deploymentId },
    });

    if (cycle) {
      this.store.updateCycle(cycle.id, {
        verificationJson: writeCycleVerification(cycle.verification, {
          evidence: input.result,
          hubEvidence,
          judgement,
        }),
      });
    }

    if (judgement.ok) {
      const deploymentId = cycle?.deploymentId ?? '';
      await this.controller.completeOperation({
        operationId: input.operationId,
        fencingGeneration: input.fencingGeneration,
        outcome: 'succeeded',
        result: { sha: judgement.sha, deploymentId },
      });
      const settled = this.store.getOperation(input.operationId)!;
      this.persistLastKnownGoodFromOp(projectId, settled);
      const fwd = this.advanceAfterEvaluate(projectId, settled);
      return {
        advanced: fwd.advanced,
        idempotent: false,
        outcome: 'succeeded',
        snapshot: fwd.snapshot,
      };
    }

    return this.recoverAfterFailedEvaluation(projectId, op, input, judgement);
  }

  private advanceAfterEvaluate(
    projectId: string,
    op: AutopilotOperationRecord,
  ): { advanced: boolean; snapshot: AutopilotRunSnapshot } {
    return this.advanceAfterStage(projectId, op, 'verifying', 'documenting');
  }

  /**
   * Documenting stage: persist a structured cycle record, publish redacted
   * evidence artifacts, and upsert the journal + runbook from saved records.
   * Completes before selecting-next. A failed journal write retries this stage
   * without merge or deployment. Duplicate completion (or a crash after the
   * documenting operation succeeded) advances without rewriting.
   */
  async runDocumenting(projectId: string): Promise<AutopilotRunSnapshot> {
    const { run, cycleId } = this.requireActiveRunningCycle(projectId);
    if (run.stage !== 'documenting') {
      return this.controller.getRun(projectId, run.id);
    }
    const documentingSucceeded = this.store
      .listStages(cycleId)
      .some((s) => s.stage === 'documenting' && s.status === 'succeeded');
    if (documentingSucceeded) {
      return this.controller.advanceStage(projectId, 'selecting-next');
    }
    const op = this.controller.claimDocumentingOperation(projectId);
    if (!op) {
      return this.controller.getRun(projectId, run.id);
    }
    try {
      if (!this.operationOwnsCurrentStage(op)) {
        return this.controller.getRun(projectId, run.id);
      }
      const persisted = await this.persistCycleDocumentation(projectId, run.id, cycleId);
      if (!this.operationOwnsCurrentStage(op)) {
        return this.controller.getRun(projectId, run.id);
      }
      await this.writeProjectDocumentationPages(projectId, run.id, cycleId);
      if (!this.operationOwnsCurrentStage(op)) {
        return this.controller.getRun(projectId, run.id);
      }
      await this.controller.completeOperation({
        operationId: op.id,
        fencingGeneration: op.fencingGeneration,
        outcome: 'succeeded',
        result: {
          journalSlug: persisted.journalSlug,
          wikiSlugs: persisted.wikiSlugs,
          artifactIds: persisted.artifactIds,
        },
      });
    } catch (err) {
      await this.settleFailureQuiet(op, err);
      return this.controller.getRun(projectId, run.id);
    }
    const settled = this.store.getRun(run.id);
    if (settled && settled.controlState === 'running' && settled.stage === 'documenting') {
      return this.controller.advanceStage(projectId, 'selecting-next');
    }
    return this.controller.getRun(projectId, run.id);
  }

  /**
   * selecting-next: rank a bounded improvement set from unmet brief goals and
   * deployment evidence, then open the next cycle only after the prior phase
   * cards are settled and this cycle's verification + documentation succeeded.
   * Scope/authority expansion pauses immediately. Three consecutive
   * rejected or no-benefit proposals pause the run. Finite-cycle mode and
   * usage envelopes stop before another cycle is filed.
   */
  async runSelectingNext(projectId: string): Promise<AutopilotRunSnapshot> {
    const existing = this.store.getActiveRun(projectId);
    if (!existing) {
      throw new AutopilotError('no_active_run', 'No active Autopilot run');
    }
    try {
      await this.controller.recordUsage(projectId, {});
    } catch (err) {
      if (isAutopilotError(err) && err.code === 'envelope_exhausted') {
        return this.controller.getRun(projectId, existing.id);
      }
      throw err;
    }
    const latest = this.store.getActiveRun(projectId) ?? existing;
    if (latest.controlState !== 'running') {
      return this.controller.getRun(projectId, latest.id);
    }
    if (latest.stage !== 'selecting-next') {
      return this.controller.getRun(projectId, latest.id);
    }
    const unfinished = this.findUnappliedSelectionHandoff(latest.id);
    if (unfinished) {
      return this.finishSelectedImprovement(projectId, unfinished.cycleId);
    }
    const cycle = this.store.getCycle(latest.id, latest.cycleNumber);
    const selectingStages = cycle
      ? this.store.listStages(cycle.id).filter((s) => s.stage === 'selecting-next')
      : [];
    if (cycle?.cardId && cycle.selectedImprovement && selectingStages.length === 0) {
      if (!(await this.priorPhasesSettledForTarget(projectId, latest, latest.cycleNumber))) {
        return this.controller.getRun(projectId, latest.id);
      }
      return this.controller.advanceStage(projectId, 'implementing');
    }
    if (!cycle) {
      throw new AutopilotError('conflict', 'No active cycle');
    }
    const selectingSucceeded = selectingStages.some((s) => s.status === 'succeeded');
    if (selectingSucceeded) {
      return this.finishSelectedImprovement(projectId, cycle.id);
    }
    if (cycle.status !== 'active') {
      if (!this.canResumeSelectingFrom(latest, cycle)) {
        throw new AutopilotError('conflict', 'No active cycle');
      }
      this.store.updateCycle(cycle.id, { status: 'active' });
    }
    if (
      latest.limits.cycleMode === 'finite' &&
      latest.limits.maxCycles != null &&
      latest.cycleNumber >= latest.limits.maxCycles
    ) {
      return this.haltSelectingNext(
        projectId,
        cycle.id,
        'finite cycle envelope is exhausted',
        'envelope',
      );
    }

    const open = this.store.getOpenStage(cycle.id);
    if (!open || open.stage !== 'selecting-next' || open.status !== 'pending') {
      this.controller.advanceStage(projectId, 'selecting-next');
    }

    const op = this.controller.claimSelectingNextOperation(projectId);
    if (!op) {
      return this.controller.getRun(projectId, latest.id);
    }
    try {
      if (!this.operationOwnsCurrentStage(op)) {
        return this.controller.getRun(projectId, latest.id);
      }
      return await this.performSelection(projectId, op, cycle.id);
    } catch (err) {
      await this.settleFailureQuiet(op, err);
      return this.controller.getRun(projectId, latest.id);
    }
  }

  /**
   * Write (or reuse) the redacted structured cycle record and evidence
   * artifacts before journal/wiki side effects. Each artifact is persisted
   * immediately after upload so a retry reuses completed keys. A retry after
   * a journal failure reuses this persisted record and does not merge or deploy.
   */
  private async persistCycleDocumentation(
    projectId: string,
    runId: string,
    cycleId: string,
    opts?: { terminal?: boolean },
  ): Promise<AutopilotStructuredCycleRecord> {
    const run = this.store.getRun(runId);
    const cycle = this.store.getCycleById(cycleId);
    if (!run || !cycle) {
      throw new AutopilotError('not_found', 'cycle not found for documentation');
    }
    const existing = parseCycleDocumentation(cycle.documentation);
    let record =
      existing ??
      redactCycleRecord(
        buildStructuredCycleRecord({
          runId,
          cycle,
          spec: this.readSpec(run.briefId),
          usage: run.usage,
          origin: this.controller.getProjectState(projectId).config.target?.origin ?? null,
          failedAttempts: this.failedAttemptsForCycle(runId, cycleId),
          documentedAt: new Date().toISOString(),
        }),
      );
    this.saveCycleRecord(cycleId, record, {
      markFailed: !!opts?.terminal && record.kind !== 'success',
    });
    const sessionId = record.links.sessionId ?? cycle.sessionId;
    if (sessionId) {
      const artifacts = this.buildEvidenceArtifacts(record, cycle);
      for (const artifact of artifacts) {
        const already = record.publishedByKey[artifact.key];
        if (already) {
          record = this.applyPublishedArtifact(record, artifact.key, already);
          continue;
        }
        const payload =
          artifact.key === 'record.json'
            ? { ...artifact, body: JSON.stringify(record, null, 2) }
            : artifact;
        const published = await this.document.publishArtifact({
          sessionId,
          cycleId,
          key: payload.key,
          filename: payload.filename,
          contentType: payload.contentType,
          body: payload.body,
        });
        record = this.applyPublishedArtifact(record, artifact.key, published.artifactId);
        this.saveCycleRecord(cycleId, record, {
          markFailed: !!opts?.terminal && record.kind !== 'success',
        });
      }
    }
    this.saveCycleRecord(cycleId, record, {
      markFailed: !!opts?.terminal && record.kind !== 'success',
    });
    return record;
  }

  private saveCycleRecord(
    cycleId: string,
    record: AutopilotStructuredCycleRecord,
    opts?: { markFailed?: boolean },
  ): void {
    this.store.updateCycle(cycleId, {
      documentationJson: JSON.stringify(record),
      outcome: record.outcome,
      ...(opts?.markFailed ? { status: 'failed' as const } : {}),
    });
  }

  private applyPublishedArtifact(
    record: AutopilotStructuredCycleRecord,
    key: string,
    artifactId: string,
  ): AutopilotStructuredCycleRecord {
    const publishedByKey = { ...record.publishedByKey, [key]: artifactId };
    const artifactIds = [...new Set(Object.values(publishedByKey))];
    const evidence = record.evidence.map((ref) => (ref.key === key ? { ...ref, artifactId } : ref));
    return { ...record, publishedByKey, artifactIds, evidence };
  }

  private documentedCyclesForProject(projectId: string): AutopilotStructuredCycleRecord[] {
    return this.store
      .listCyclesForProject(projectId)
      .map((c) => parseCycleDocumentation(c.documentation))
      .filter((r): r is AutopilotStructuredCycleRecord => !!r);
  }

  private async writeProjectDocumentationPages(
    projectId: string,
    runId: string,
    cycleId: string,
  ): Promise<void> {
    const run = this.store.getRun(runId);
    const records = this.documentedCyclesForProject(projectId);
    const lastVerifiedSha = run?.lastVerifiedSha ?? null;
    const lastDeploymentId = run?.lastDeploymentId ?? null;
    const current = currentVerifiedRecord({ lastVerifiedSha, lastDeploymentId, records });
    const pages = buildDocumentationPages({
      lastVerifiedSha,
      lastDeploymentId,
      origin:
        current?.links.deploymentOrigin ??
        this.controller.getProjectState(projectId).config.target?.origin ??
        null,
      records,
    });
    await this.document.writePages({ projectId, runId, cycleId, pages });
  }

  private async afterFailedOperation(
    projectId: string,
    op: AutopilotOperationRecord,
  ): Promise<void> {
    const run = this.store.getRun(op.runId);
    if (!run || !op.cycleId) return;
    if (
      run.controlState !== 'paused' &&
      run.controlState !== 'failed' &&
      run.controlState !== 'stopping' &&
      run.controlState !== 'stopped'
    ) {
      return;
    }
    try {
      await this.persistCycleDocumentation(projectId, run.id, op.cycleId, { terminal: true });
      await this.writeProjectDocumentationPages(projectId, run.id, op.cycleId);
    } catch {
      // Halt already settled. Journal retry happens on documenting or the next terminal.
    }
  }

  private failedAttemptsForCycle(runId: string, cycleId: string): AutopilotFailedAttempt[] {
    const kinds = new Set(['implement', 'finalize', 'deploy', 'evaluate']);
    return this.store
      .listOperations(runId)
      .filter((op) => op.cycleId === cycleId && op.status === 'failed' && kinds.has(op.kind))
      .map((op) => {
        const result = (op.result ?? {}) as {
          reason?: unknown;
          detail?: unknown;
          error?: unknown;
          message?: unknown;
          status?: unknown;
        };
        const reason =
          typeof result.reason === 'string'
            ? result.reason
            : typeof result.error === 'string'
              ? result.error
              : typeof result.message === 'string'
                ? result.message
                : typeof result.status === 'string'
                  ? result.status
                  : `${op.kind}-failed`;
        return {
          operationId: op.id,
          reason: `${op.kind}: ${reason}`,
          detail: typeof result.detail === 'string' ? result.detail : undefined,
        };
      });
  }

  private buildEvidenceArtifacts(
    record: AutopilotStructuredCycleRecord,
    cycle: { verification: unknown },
  ): AutopilotEvidenceArtifact[] {
    const artifacts: AutopilotEvidenceArtifact[] = [];
    for (const ref of record.evidence) {
      if ((ref.kind !== 'screenshot' && ref.kind !== 'trace') || !ref.path || !ref.key) continue;
      const file = this.readEvidenceFile(ref.path);
      if (!file) continue;
      const prepared = this.prepareEvidenceBody(file.contentType, file.body);
      artifacts.push({
        key: ref.key,
        filename: `cycle-${record.cycleNumber}-${ref.key.replace(/[^A-Za-z0-9._-]+/g, '-')}${extname(ref.path) || ''}`,
        contentType: file.contentType,
        body: prepared.body,
      });
    }
    if (cycle.verification) {
      const { value } = redactAutopilotValue(cycle.verification);
      artifacts.push({
        key: 'evaluation.json',
        filename: `cycle-${record.cycleNumber}-evaluation.json`,
        contentType: 'application/json',
        body: JSON.stringify(value, null, 2),
      });
    }
    artifacts.push({
      key: 'record.json',
      filename: `cycle-${record.cycleNumber}-record.json`,
      contentType: 'application/json',
      body: JSON.stringify(record, null, 2),
    });
    return artifacts;
  }

  private prepareEvidenceBody(
    contentType: string,
    body: Buffer,
  ): { body: Buffer; redactions: number } {
    if (!/json|text|javascript/i.test(contentType)) return { body, redactions: 0 };
    const text = body.toString('utf8');
    try {
      const parsed = JSON.parse(text) as unknown;
      const { value, redactions } = redactAutopilotValue(parsed);
      return { body: Buffer.from(JSON.stringify(value), 'utf8'), redactions };
    } catch {
      const { value, redactions } = redactAutopilotValue(text);
      return { body: Buffer.from(String(value), 'utf8'), redactions };
    }
  }

  /**
   * Reconcile last-known-good from a succeeded evaluate operation. A crash
   * between completeOperation and promote must not advance documenting
   * without recording the verified SHA.
   */
  private async performSelection(
    projectId: string,
    op: AutopilotOperationRecord,
    cycleId: string,
  ): Promise<AutopilotRunSnapshot> {
    const run = this.store.getRun(op.runId);
    const cycle = this.store.getCycleById(cycleId);
    if (!run || !cycle) {
      throw new AutopilotError('not_found', 'cycle not found for selection');
    }
    const spec = this.readSpec(run.briefId);
    if (!spec) {
      throw new AutopilotError('invalid_config', 'run has no baseline spec to select from');
    }
    const brief = run.briefId ? this.store.getBrief(run.briefId) : null;
    if (!brief) {
      throw new AutopilotError('not_found', 'brief not found for run');
    }
    const priorImprovements = this.store
      .listCycles(run.id)
      .map((row) => parseSelectedImprovementRecord(row.selectedImprovement))
      .filter((row): row is AutopilotSelectedImprovement => row != null);
    const failedAttempts = this.failedAttemptsForCycle(run.id, cycleId);
    const frozen = this.findFrozenSelection(run.id, cycleId);
    let selected = frozen;
    if (!selected) {
      const ranked = rankImprovementCandidates({
        brief: brief.content,
        briefRevision: brief.revision,
        spec,
        lastVerification: cycle.verification,
        failedAttempts,
        priorImprovements,
      });
      let plannerProposal: AutopilotImprovementProposal | null = null;
      if (this.planner.proposeImprovements) {
        plannerProposal = await this.planner.proposeImprovements({
          projectId,
          runId: run.id,
          cycleNumber: cycle.cycleNumber,
          brief: brief.content,
          briefRevision: brief.revision,
          spec,
          ranked,
          lastVerification: cycle.verification,
          failedAttempts,
          priorImprovements,
        });
        if (!this.operationOwnsCurrentStage(op)) {
          return this.controller.getRun(projectId, run.id);
        }
      }
      const proposal = applyPlannerProposal(ranked, spec, plannerProposal, brief.content);
      if (proposal.outcome === 'needs-expanded-authority') {
        return this.haltSelectingNext(
          projectId,
          cycleId,
          proposal.reason ?? 'proposal needs expanded authority or scope',
          'needs-expanded-authority',
          op,
        );
      }
      if (proposal.outcome === 'no-benefit' || proposal.outcome === 'rejected') {
        return this.recordSelectionDeadEnd(projectId, op, cycleId, proposal);
      }
      selected = proposal.selected;
      if (!selected) {
        return this.recordSelectionDeadEnd(projectId, op, cycleId, {
          ...proposal,
          outcome: 'no-benefit',
          reason: proposal.reason ?? 'no remaining in-scope improvement with a falsifiable benefit',
        });
      }
    }

    const epicId = this.findEpicId(run.id);
    if (!epicId) {
      throw new AutopilotError('invalid_config', 'run has no epic to file the next phase on');
    }
    const nextNumber = cycle.cycleNumber + 1;
    const idempotencyKey = `autopilot:${run.id}:cycle-${nextNumber}`;
    const prior = await this.board.priorPhaseComplete({
      projectId,
      epicId,
      idempotencyKey,
    });
    if (!this.operationOwnsCurrentStage(op)) {
      return this.controller.getRun(projectId, run.id);
    }
    if (!prior.ok) {
      return this.reopenSelectingNext(projectId, op, {
        outcome: 'gated',
        reason: prior.reason ?? 'prior phase cards are not settled',
      });
    }

    this.freezeSelection(op, selected, idempotencyKey, cycle.cycleNumber);
    const board = await this.board.createImprovementBoard({
      projectId,
      runId: run.id,
      epicId,
      idempotencyKey,
      improvement: selected,
      blockedByCardIds: cycle.cardId ? [cycle.cardId] : [],
      specDecisions: selected.specDecisions ?? [],
    });
    const ordering = await this.board.validatePhaseOrder({ projectId, epicId: board.epicId });
    if (!ordering.ok) {
      throw new AutopilotError(
        'invalid_config',
        `phase dependency order is invalid: ${ordering.reason ?? 'unknown'}`,
      );
    }
    if (!this.operationOwnsCurrentStage(op)) {
      return this.controller.getRun(projectId, run.id);
    }
    const mergedSpec = mergeInScopeSpecDecisions(spec, selected.specDecisions);
    this.store.updateBriefSpec(run.briefId!, JSON.stringify(mergedSpec));

    await this.controller.completeOperation({
      operationId: op.id,
      fencingGeneration: op.fencingGeneration,
      outcome: 'succeeded',
      result: {
        outcome: 'selected',
        selected,
        epicId: board.epicId,
        primaryCardId: board.primaryCardId,
        cardIds: board.cards.map((c) => c.cardId),
        specRevision: brief.revision,
      },
    });
    this.store.insertEvent({
      runId: run.id,
      cycleId,
      operationId: op.id,
      type: 'improvement_selected',
      payload: { id: selected.id, kind: selected.kind, action: selected.action },
      fencingGeneration: run.fencingGeneration,
      createdAt: new Date().toISOString(),
    });
    return this.finishSelectedImprovement(projectId, cycleId);
  }

  /**
   * Apply a succeeded select-next onto the successor cycle. Recovery rechecks
   * predecessor completion against the persisted target-cycle key so a
   * reopened prior card cannot dispatch the next implementation.
   */
  private async finishSelectedImprovement(
    projectId: string,
    cycleId: string,
  ): Promise<AutopilotRunSnapshot> {
    const run = this.store.getActiveRun(projectId);
    if (!run) {
      throw new AutopilotError('no_active_run', 'No active Autopilot run');
    }
    const selectedOp =
      this.store
        .listOperations(run.id)
        .filter(
          (row) =>
            row.kind === 'select-next' && row.cycleId === cycleId && row.status === 'succeeded',
        )
        .pop() ?? null;
    if (!selectedOp) {
      return this.controller.getRun(projectId, run.id);
    }
    const result = (selectedOp.result ?? {}) as {
      outcome?: unknown;
      selected?: unknown;
      primaryCardId?: unknown;
      specRevision?: unknown;
    };
    if (result.outcome !== 'selected' || typeof result.primaryCardId !== 'string') {
      return this.controller.getRun(projectId, run.id);
    }
    const selected = parseSelectedFromResult(result.selected);
    if (!selected) {
      return this.controller.getRun(projectId, run.id);
    }
    if (run.controlState !== 'running') {
      return this.controller.getRun(projectId, run.id);
    }
    const source = this.store.getCycleById(cycleId);
    const nextNumber =
      source && run.cycleNumber === source.cycleNumber ? source.cycleNumber + 1 : run.cycleNumber;
    const intent = (selectedOp.intent ?? {}) as { idempotencyKey?: unknown };
    const persistedKey = typeof intent.idempotencyKey === 'string' ? intent.idempotencyKey : null;
    if (!(await this.priorPhasesSettledForTarget(projectId, run, nextNumber, persistedKey))) {
      return this.controller.getRun(projectId, run.id);
    }
    const latest = this.store.getActiveRun(projectId);
    if (!latest || latest.controlState !== 'running') {
      return this.controller.getRun(projectId, run.id);
    }
    const successor =
      source && latest.cycleNumber > source.cycleNumber
        ? this.store.getCycle(run.id, latest.cycleNumber)
        : null;
    const spec = this.readSpec(latest.briefId);
    const specRevision =
      typeof result.specRevision === 'number'
        ? result.specRevision
        : (successor?.specRevision ?? source?.specRevision ?? run.briefRevision ?? 1);
    const patch: {
      cardId: string;
      specRevision: number;
      selectedImprovement: string;
      verificationJson?: string;
    } = {
      cardId: result.primaryCardId,
      specRevision,
      selectedImprovement: serializeSelectedImprovement(selected),
    };
    if (spec) {
      const prior = this.store
        .listCycles(run.id)
        .filter((row) => row.cycleNumber < nextNumber)
        .map((row) => parseSelectedImprovementRecord(row.selectedImprovement))
        .filter((row): row is AutopilotSelectedImprovement => row != null);
      patch.verificationJson = writeCycleVerification(successor?.verification ?? null, {
        pinned: pinCriteriaFromSpec(
          spec,
          specRevision,
          extraProtectedJourneys(spec, prior, selected),
        ),
      });
    }
    this.controller.applySelectionHandoff(projectId, cycleId, patch);
    const opened = this.store.getActiveRun(projectId);
    if (!opened || opened.controlState !== 'running') {
      return this.controller.getRun(projectId, run.id);
    }
    if (opened.stage === 'selecting-next') {
      return this.controller.advanceStage(projectId, 'implementing');
    }
    return this.controller.getRun(projectId, opened.id);
  }

  /**
   * Recheck every predecessor phase against the next cycle's key. A crash
   * after select-next succeeds can leave a window where a human reopens a
   * prior card; recovery must not open the successor until those cards are
   * Done again. Prefer the key frozen on the operation intent so retries keep
   * excluding the same target phase.
   */
  private async priorPhasesSettledForTarget(
    projectId: string,
    run: NonNullable<ReturnType<AutopilotStore['getActiveRun']>>,
    targetCycleNumber: number,
    persistedKey?: string | null,
  ): Promise<boolean> {
    const epicId = this.findEpicId(run.id);
    if (!epicId) return false;
    const idempotencyKey =
      persistedKey && persistedKey.trim()
        ? persistedKey.trim()
        : `autopilot:${run.id}:cycle-${targetCycleNumber}`;
    const prior = await this.board.priorPhaseComplete({
      projectId,
      epicId,
      idempotencyKey,
    });
    return prior.ok;
  }

  /**
   * A succeeded select-next is unfinished until some cycle holds that card and
   * selected improvement. Recovery must finish the predecessor's handoff even
   * after `openNextCycle` has already advanced `cycleNumber`.
   */
  private findUnappliedSelectionHandoff(runId: string): { cycleId: string } | null {
    const cycles = this.store.listCycles(runId);
    for (const op of [...this.store.listOperations(runId)].reverse()) {
      if (op.kind !== 'select-next' || op.status !== 'succeeded' || !op.cycleId) continue;
      const result = (op.result ?? {}) as { outcome?: unknown; primaryCardId?: unknown };
      if (result.outcome !== 'selected' || typeof result.primaryCardId !== 'string') continue;
      const applied = cycles.some(
        (row) => row.cardId === result.primaryCardId && !!row.selectedImprovement,
      );
      if (!applied) return { cycleId: op.cycleId };
    }
    return null;
  }

  /**
   * Once a proposal has been written to a select-next intent, later retries
   * must reuse it. Re-ranking after a partial board write would file B against
   * a card that still instructs A.
   */
  private findFrozenSelection(runId: string, cycleId: string): AutopilotSelectedImprovement | null {
    for (const op of this.store.listOperations(runId)) {
      if (op.kind !== 'select-next' || op.cycleId !== cycleId) continue;
      const intent = (op.intent ?? {}) as { selected?: unknown };
      const selected = parseSelectedFromResult(intent.selected);
      if (selected) return selected;
    }
    return null;
  }

  private freezeSelection(
    op: AutopilotOperationRecord,
    selected: AutopilotSelectedImprovement,
    idempotencyKey: string,
    cycleNumber: number,
  ): void {
    const intent =
      op.intent && typeof op.intent === 'object' && !Array.isArray(op.intent)
        ? (op.intent as Record<string, unknown>)
        : {};
    this.store.updateOperation(op.id, {
      intentJson: JSON.stringify({
        ...intent,
        stage: 'selecting-next',
        cycleNumber,
        selected,
        idempotencyKey,
      }),
    });
  }

  private async haltSelectingNext(
    projectId: string,
    cycleId: string,
    reason: string,
    outcome: string,
    existingOp?: AutopilotOperationRecord,
  ): Promise<AutopilotRunSnapshot> {
    const run = this.store.getActiveRun(projectId);
    if (!run) {
      throw new AutopilotError('no_active_run', 'No active Autopilot run');
    }
    const op = existingOp ?? this.controller.claimSelectingNextOperation(projectId);
    if (op) {
      await this.controller.completeOperation({
        operationId: op.id,
        fencingGeneration: op.fencingGeneration,
        outcome: 'failed',
        skipStageRetry: true,
        haltReason: reason,
        result: { outcome, reason },
      });
      if (outcome !== 'envelope') {
        this.store.insertEvent({
          runId: run.id,
          cycleId,
          operationId: op.id,
          type:
            outcome === 'needs-expanded-authority'
              ? 'improvement_rejected'
              : 'improvement_no_benefit',
          payload: { reason, outcome },
          fencingGeneration: run.fencingGeneration,
          createdAt: new Date().toISOString(),
        });
      }
    }
    return this.controller.getRun(projectId, run.id);
  }

  /**
   * A selecting-next pause is not a finished cycle. The verified source cycle
   * stays current so resume can rank again; closing it belongs to a succeeded
   * selection handoff.
   */
  private canResumeSelectingFrom(
    run: { stage: string | null; cycleNumber: number; id: string },
    cycle: { status: string; cycleNumber: number },
  ): boolean {
    if (run.stage !== 'selecting-next') return false;
    if (cycle.status === 'failed' || cycle.status === 'cancelled') return false;
    if (cycle.cycleNumber !== run.cycleNumber) return false;
    return this.store.getCycle(run.id, cycle.cycleNumber + 1) == null;
  }

  private async recordSelectionDeadEnd(
    projectId: string,
    op: AutopilotOperationRecord,
    cycleId: string,
    proposal: AutopilotImprovementProposal,
  ): Promise<AutopilotRunSnapshot> {
    const run = this.store.getRun(op.runId);
    if (!run) {
      throw new AutopilotError('not_found', 'run not found for selection');
    }
    const streak = consecutiveNoBenefitStreak(this.store.listEvents(run.id, 200)) + 1;
    const reason =
      proposal.reason ??
      (proposal.outcome === 'rejected'
        ? 'proposed improvement was rejected'
        : 'no remaining in-scope improvement with a falsifiable benefit');
    if (streak >= AUTOPILOT_NO_BENEFIT_PAUSE_STREAK) {
      return this.haltSelectingNext(
        projectId,
        cycleId,
        `three consecutive rejected/no-benefit proposals: ${reason}`,
        proposal.outcome,
        op,
      );
    }
    await this.controller.completeOperation({
      operationId: op.id,
      fencingGeneration: op.fencingGeneration,
      outcome: 'failed',
      skipStageRetry: true,
      result: { outcome: proposal.outcome, reason, streak },
    });
    this.store.insertEvent({
      runId: run.id,
      cycleId,
      operationId: op.id,
      type: proposal.outcome === 'rejected' ? 'improvement_rejected' : 'improvement_no_benefit',
      payload: { reason, streak },
      fencingGeneration: run.fencingGeneration,
      createdAt: new Date().toISOString(),
    });
    const latest = this.store.getActiveRun(projectId);
    if (latest && latest.controlState === 'running' && latest.stage === 'selecting-next') {
      return this.controller.advanceStage(projectId, 'selecting-next');
    }
    return this.controller.getRun(projectId, run.id);
  }

  private async reopenSelectingNext(
    projectId: string,
    op: AutopilotOperationRecord,
    result: { outcome: string; reason: string },
  ): Promise<AutopilotRunSnapshot> {
    await this.controller.completeOperation({
      operationId: op.id,
      fencingGeneration: op.fencingGeneration,
      outcome: 'failed',
      skipStageRetry: true,
      result,
    });
    const latest = this.store.getActiveRun(projectId);
    if (latest && latest.controlState === 'running' && latest.stage === 'selecting-next') {
      return this.controller.advanceStage(projectId, 'selecting-next');
    }
    return this.controller.getRun(projectId, op.runId);
  }

  private findEpicId(runId: string): string | null {
    for (const op of [...this.store.listOperations(runId)].reverse()) {
      const result = (op.result ?? {}) as { epicId?: unknown };
      if (typeof result.epicId === 'string' && result.epicId.trim()) return result.epicId.trim();
    }
    return null;
  }

  private persistLastKnownGoodFromOp(projectId: string, op: AutopilotOperationRecord): void {
    const result = op.result as { sha?: unknown; deploymentId?: unknown } | null;
    const sha = typeof result?.sha === 'string' ? result.sha.trim() : '';
    const deploymentId = typeof result?.deploymentId === 'string' ? result.deploymentId.trim() : '';
    if (!sha || !deploymentId) return;
    const run = this.store.getRun(op.runId);
    if (!run || run.stage !== 'verifying' || run.controlState !== 'running') return;
    if (run.lastVerifiedSha === sha && run.lastDeploymentId === deploymentId) return;
    this.controller.promoteLastKnownGood(projectId, { sha, deploymentId });
  }

  private requireTargetOrigin(targetId: string | null, projectId: string): string {
    const state = this.controller.getProjectState(projectId);
    const origin = state.config.target?.origin?.trim() ?? '';
    if (!targetId || !origin) {
      throw new AutopilotError('invalid_config', 'run has no experiment target origin');
    }
    return origin.replace(/\/+$/, '');
  }

  /**
   * Roll back to last-known-good after a failed evaluation, then reopen
   * implementing for a budgeted repair. Never advances to documenting or
   * selecting-next. Failed terminal outcomes persist a cycle record in place
   * so unsuccessful work survives into the journal and handoff.
   */
  private async recoverAfterFailedEvaluation(
    projectId: string,
    op: AutopilotOperationRecord,
    input: AutopilotReconcileInput<AutopilotEvaluationReport | null>,
    judgement: Extract<AutopilotEvaluationJudgement, { ok: false }>,
  ): Promise<AutopilotReconcileOutcome> {
    const run = this.store.getRun(op.runId);
    const fail = async (haltReason: string, extra: Record<string, unknown> = {}) => {
      await this.controller.completeOperation({
        operationId: input.operationId,
        fencingGeneration: input.fencingGeneration,
        outcome: 'failed',
        haltReason,
        result: { reason: judgement.reason, detail: judgement.detail, ...extra },
      });
      await this.afterFailedOperation(projectId, this.store.getOperation(input.operationId)!);
      return {
        advanced: false,
        idempotent: false,
        outcome: 'failed' as const,
        snapshot: this.controller.getRun(projectId, op.runId),
      };
    };
    const extra: Record<string, unknown> = {};
    if (run?.lastVerifiedSha && run.lastDeploymentId && run.targetId) {
      let rolled;
      try {
        rolled = await this.deploy.rollback({
          projectId,
          runId: run.id,
          operationId: op.id,
          targetId: run.targetId,
          priorDeploymentId: run.lastDeploymentId,
          priorSha: run.lastVerifiedSha,
        });
      } catch (err) {
        return fail('evaluation failed; recovery failed', {
          rollbackError: err instanceof Error ? err.message : String(err),
        });
      }
      if (rolled.status !== 'success' || rolled.deployedSha !== run.lastVerifiedSha) {
        return fail('evaluation failed; recovery failed', {
          rollbackStatus: rolled.status,
          restoredSha: rolled.deployedSha ?? null,
        });
      }
      extra.restoredSha = rolled.deployedSha;
      extra.rollbackDeploymentId = rolled.deploymentId;
    }

    const stage = this.store.getStageByOperationId(op.id);
    const maxRetries = run?.limits.maxRetriesPerStage ?? 0;
    const canRepair = !!run && !!stage && stage.attempt <= maxRetries;
    if (!canRepair) {
      const suffix = extra.restoredSha
        ? 'recovered last-known-good; repair budget exhausted'
        : 'no last-known-good to recover';
      return fail(`evaluation ${judgement.reason}; ${suffix}`, extra);
    }

    await this.controller.completeOperation({
      operationId: input.operationId,
      fencingGeneration: input.fencingGeneration,
      outcome: 'failed',
      skipStageRetry: true,
      result: { reason: judgement.reason, detail: judgement.detail, repair: true, ...extra },
    });
    const snapshot = this.controller.advanceStage(projectId, 'implementing');
    return {
      advanced: true,
      idempotent: false,
      outcome: 'failed',
      snapshot,
    };
  }

  /**
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
    return this.advanceAfterStage(projectId, op, 'implementing', 'finalizing');
  }

  private advanceAfterStage(
    projectId: string,
    op: AutopilotOperationRecord,
    fromStage: AutopilotRunSnapshot['run']['stage'],
    toStage: NonNullable<AutopilotRunSnapshot['run']['stage']>,
  ): { advanced: boolean; snapshot: AutopilotRunSnapshot } {
    const runId = op.runId;
    const stay = (): { advanced: boolean; snapshot: AutopilotRunSnapshot } => ({
      advanced: false,
      snapshot: this.controller.getRun(projectId, runId),
    });
    const run = this.store.getRun(runId);
    if (!run || run.controlState !== 'running' || run.stage !== fromStage) return stay();
    if (op.status !== 'succeeded' || op.fencingGeneration !== run.fencingGeneration) return stay();
    const cycle = this.store.getCycle(run.id, run.cycleNumber);
    if (!cycle || cycle.id !== op.cycleId) return stay();
    const stage = this.store.getStageByOperationId(op.id);
    if (
      !stage ||
      stage.cycleId !== cycle.id ||
      stage.stage !== fromStage ||
      stage.status !== 'succeeded'
    ) {
      return stay();
    }
    return { advanced: true, snapshot: this.controller.advanceStage(projectId, toStage) };
  }

  /**
   * Reconcile the merged SHA from a succeeded Finalize operation onto its cycle.
   * Duplicate callbacks of an older finalize are no-ops so they cannot rewind a
   * later repair merge. The latest succeeded finalize for the cycle wins.
   */
  private persistMergedShaFromOp(op: AutopilotOperationRecord): boolean {
    if (!op.cycleId) return false;
    const sha = (op.result as { mergedSha?: unknown } | null)?.mergedSha;
    if (typeof sha !== 'string' || !sha) return false;
    const latest = this.store
      .listOperations(op.runId)
      .filter(
        (row) =>
          row.kind === 'finalize' && row.status === 'succeeded' && row.cycleId === op.cycleId,
      )
      .at(-1);
    if (!latest || latest.id !== op.id) return false;
    const cycle = this.store.getCycleById(op.cycleId);
    if (!cycle || cycle.testedCommitSha === sha) return false;
    this.store.updateCycle(op.cycleId, { testedCommitSha: sha });
    return true;
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
    ref: { sessionId: string } | { finalizeRunId: string } | { deploymentId: string },
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
    const run = this.store.getRun(op.runId);
    const settled = this.store.getOperation(op.id);
    if (run && settled) await this.afterFailedOperation(run.projectId, settled);
  }
}

function parseSelectedFromResult(raw: unknown): AutopilotSelectedImprovement | null {
  if (raw && typeof raw === 'object') {
    return parseSelectedImprovementRecord(
      serializeSelectedImprovement(raw as AutopilotSelectedImprovement),
    );
  }
  if (typeof raw === 'string') return parseSelectedImprovementRecord(raw);
  return null;
}

export function createAutopilotOrchestrator(
  deps: AutopilotOrchestratorDeps,
): AutopilotOrchestrator {
  return new AutopilotOrchestrator(deps);
}
