import { randomUUID } from 'crypto';
import { assessStorageRecoverability } from './local-target.js';
import type {
  AutopilotAcceptanceJourney,
  AutopilotBaselineSpec,
  AutopilotBoardPort,
  AutopilotDeployPort,
  AutopilotDeployResult,
  AutopilotEvaluatePort,
  AutopilotFinalizePort,
  AutopilotFinalizeResult,
  AutopilotImplementationContext,
  AutopilotPlannerInput,
  AutopilotPlannerPort,
  AutopilotPlannedBoard,
  AutopilotSessionPort,
} from './orchestrator.js';
import type { AutopilotPinnedCriteria } from './evaluate.js';

/**
 * Concrete adapters that bind the Autopilot orchestrator's ports to the real
 * Hub subsystems (planning session, kanban board, Finalize automation). Each
 * adapter takes a narrow set of injected operations rather than the whole
 * RouteDeps/Stmts singleton, so it is unit-testable with plain fakes and
 * index.ts wires the production functions.
 */

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export interface AutopilotPlannerOps {
  /**
   * Run a bounded planning session that RESOLVES the loose brief into a
   * concrete baseline: acceptance journeys each with a real end-user action and
   * an observable expected state, inferred assumptions, non-goals, and locked
   * in-scope decisions (with scope/storage choices resolved). Resolution is the
   * agent's job — the deterministic adapter never invents brief semantics. The
   * production impl (index.ts/wiring.ts) dispatches the session and parses its
   * structured output; tests inject a deterministic fake.
   */
  planBaseline: (input: AutopilotPlannerInput) => Promise<unknown>;
}

export interface AutopilotPlannerAdapterDeps {
  ops: AutopilotPlannerOps;
}

function requireNonEmptyStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Autopilot planner produced an incomplete baseline: ${label} is empty`);
  }
  const out = value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
  if (out.length === 0) {
    throw new Error(`Autopilot planner produced an incomplete baseline: ${label} is empty`);
  }
  return out;
}

/**
 * Validate + normalise the planning session's output into a baseline spec, or
 * throw (planning then retries/pauses per the controller). Enforces that every
 * acceptance journey carries a concrete action AND an observable expected
 * result — a raw brief sentence with no resolved outcome is rejected — and that
 * an in-scope storage decision and a supported storageRecovery contract
 * (`disposable` or `backward-compatible`) were actually resolved. Recovery is
 * never inferred from storage prose, and unknown/unsupported kinds are not a
 * deployable baseline.
 */
export function validateBaselineSpec(raw: unknown): AutopilotBaselineSpec {
  const fail = (why: string): never => {
    throw new Error(`Autopilot planner produced an incomplete baseline: ${why}`);
  };
  if (!raw || typeof raw !== 'object') fail('not an object');
  const spec = raw as Record<string, unknown>;

  const journeysRaw = Array.isArray(spec.acceptanceJourneys) ? spec.acceptanceJourneys : [];
  if (journeysRaw.length === 0) fail('no acceptance journeys');
  const acceptanceJourneys: AutopilotAcceptanceJourney[] = journeysRaw.map((j, i) => {
    const journey = (j ?? {}) as Record<string, unknown>;
    const action = typeof journey.action === 'string' ? journey.action.trim() : '';
    const expectedResult =
      typeof journey.expectedResult === 'string' ? journey.expectedResult.trim() : '';
    if (!action) fail(`journey ${i} has no concrete user action`);
    if (!expectedResult) fail(`journey ${i} has no observable expected result`);
    return { action, expectedResult };
  });

  const assumptions = requireNonEmptyStrings(spec.assumptions, 'assumptions');
  const nonGoals = requireNonEmptyStrings(spec.nonGoals, 'nonGoals');

  const decisionsRaw = Array.isArray(spec.specDecisions) ? spec.specDecisions : [];
  const specDecisions = decisionsRaw
    .map((d) => {
      const dec = (d ?? {}) as Record<string, unknown>;
      const key = typeof dec.key === 'string' ? dec.key.trim() : '';
      const decision = typeof dec.decision === 'string' ? dec.decision.trim() : '';
      return key && decision ? { key, decision } : null;
    })
    .filter((d): d is { key: string; decision: string } => d != null);
  if (!specDecisions.some((d) => d.key === 'storage')) {
    fail('storage decision was not resolved');
  }

  const recovery = assessStorageRecoverability({
    storageRecovery: spec.storageRecovery,
    specDecisions,
  });
  const storageRecovery = recovery.ok
    ? recovery.kind
    : fail(`storage recovery contract: ${recovery.reason}`);

  const qualityRubricVersion =
    typeof spec.qualityRubricVersion === 'number' && spec.qualityRubricVersion >= 1
      ? Math.floor(spec.qualityRubricVersion)
      : fail('missing quality rubric version');

  return {
    assumptions,
    acceptanceJourneys,
    nonGoals,
    specDecisions,
    storageRecovery,
    qualityRubricVersion,
  };
}

/**
 * Agent-backed baseline planner. Resolution of the loose brief into concrete,
 * testable acceptance behaviour is delegated to a bounded planning session (the
 * `planBaseline` op); this adapter only validates that the session returned a
 * fully-resolved baseline (concrete action + observable result per journey,
 * resolved decisions) and rejects a degenerate/pass-through result so nothing
 * unresolved is ever persisted or filed.
 */
export function createAutopilotPlannerAdapter(
  deps: AutopilotPlannerAdapterDeps,
): AutopilotPlannerPort {
  return {
    expandBrief: async (input) => validateBaselineSpec(await deps.ops.planBaseline(input)),
  };
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export interface AutopilotBoardOps {
  /** Return the project's board id, creating the board + default columns if needed. */
  ensureBoard: (projectId: string) => { boardId: string };
  /** Resolve the "To Do" column id for a board. */
  todoColumnId: (boardId: string) => string;
  /** Find a prior epic created for this idempotency key, if any. */
  findEpicByKey: (boardId: string, idempotencyKey: string) => { epicId: string } | null;
  createEpic: (args: {
    id: string;
    boardId: string;
    name: string;
    description: string;
    labels: string;
    position: number;
  }) => void;
  nextEpicPosition: (boardId: string) => number;
  /** Find-or-create the epic's single baseline phase; returns its id (idempotent). */
  ensurePhase: (args: { epicId: string; boardId: string }) => { phaseId: string };
  /**
   * List the epic's existing cards with their durable Autopilot key (stored by
   * createCard, independent of the display title) so a retry reconciles by a
   * stable identity, not by truncatable/collidable title text.
   */
  listCardsForEpic: (epicId: string) => { id: string; key: string }[];
  createCard: (args: {
    id: string;
    /** Durable, content-independent identity for reconcile (persisted, not shown). */
    key: string;
    columnId: string;
    boardId: string;
    epicId: string;
    phaseId: string;
    title: string;
    description: string;
    position: number;
  }) => void;
  nextCardPosition: (columnId: string) => number;
  /** Add a blocker edge; MUST be a no-op if the edge already exists. */
  addBlocker: (args: { id: string; cardId: string; blockedByCardId: string }) => void;
  /** Topologically validate + persist phase order; returns ok/false with a reason. */
  validateAndSaveOrder: (epicId: string) => { ok: boolean; reason?: string };
}

export interface AutopilotBoardAdapterDeps {
  ops: AutopilotBoardOps;
  randomId?: () => string;
}

const AUTOPILOT_KEY_LABEL = 'autopilot-key:';
const PRIMARY_CARD_TITLE = 'Implement the Autopilot baseline';

/** Render a resolved journey as a testable "When <action>, then <result>" line. */
function renderJourney(j: AutopilotAcceptanceJourney): string {
  return `When a user ${j.action}, then ${j.expectedResult}.`;
}

function journeyCardTitle(journey: AutopilotAcceptanceJourney): string {
  return `Verify journey: ${journey.action}`.slice(0, 120);
}

/**
 * Create/reconcile the epic/phase/cards + blockers for a baseline. This is a
 * full reconcile, not a first-write-wins early return: on every call it
 * find-or-creates the epic (by idempotency-key label), the phase, the primary
 * card and every journey card (matched by stable title), and every journey ->
 * primary blocker edge. A crash after a partial write (e.g. the primary card
 * landed but journey cards did not) is fully repaired on the next call rather
 * than permanently skipped. Card creation and blocker edges are idempotent, so
 * re-running never duplicates rows.
 */
export function createAutopilotBoardAdapter(deps: AutopilotBoardAdapterDeps): AutopilotBoardPort {
  const randomId = deps.randomId ?? randomUUID;
  const ops = deps.ops;
  return {
    createBaselineBoard: async ({
      projectId,
      spec,
      idempotencyKey,
    }): Promise<AutopilotPlannedBoard> => {
      const { boardId } = ops.ensureBoard(projectId);

      // Epic: reuse the one filed under this key, else create it.
      const existing = ops.findEpicByKey(boardId, idempotencyKey);
      const epicId = existing?.epicId ?? randomId();
      if (!existing) {
        ops.createEpic({
          id: epicId,
          boardId,
          name: 'Autopilot baseline',
          description: `Baseline scoped by Autopilot.\n\nAcceptance journeys:\n${spec.acceptanceJourneys
            .map((j) => `- ${renderJourney(j)}`)
            .join('\n')}\n\nNon-goals:\n${spec.nonGoals.map((n) => `- ${n}`).join('\n')}`,
          labels: `${AUTOPILOT_KEY_LABEL}${idempotencyKey}`,
          position: ops.nextEpicPosition(boardId),
        });
      }

      const { phaseId } = ops.ensurePhase({ epicId, boardId });
      const columnId = ops.todoColumnId(boardId);

      // Reconcile by a DURABLE per-cycle key (not the display title, which is
      // truncated and can collide): a retry only fills in what is missing, and
      // two journeys with the same title prefix stay distinct cards.
      const byKey = new Map(ops.listCardsForEpic(epicId).map((c) => [c.key, c.id]));
      const ensureCard = (key: string, title: string, description: string): string => {
        const found = byKey.get(key);
        if (found) return found;
        const id = randomId();
        ops.createCard({
          id,
          key,
          columnId,
          boardId,
          epicId,
          phaseId,
          title,
          description,
          position: ops.nextCardPosition(columnId),
        });
        byKey.set(key, id);
        return id;
      };

      const primaryCardId = ensureCard(
        `${idempotencyKey}#primary`,
        PRIMARY_CARD_TITLE,
        `Deliver the baseline main flow.\n\nAcceptance journeys:\n${spec.acceptanceJourneys
          .map((j) => `- ${renderJourney(j)}`)
          .join('\n')}`,
      );

      const cards: AutopilotPlannedBoard['cards'] = [
        { cardId: primaryCardId, title: PRIMARY_CARD_TITLE, phase: 1, blockedBy: [] },
      ];

      // One card per additional acceptance journey, keyed by its journey index
      // so distinct journeys never collapse. Card and blocker creation are
      // idempotent, so this repairs a partially-created board without dupes.
      spec.acceptanceJourneys.slice(1).forEach((journey, i) => {
        const cardId = ensureCard(
          `${idempotencyKey}#journey-${i + 1}`,
          journeyCardTitle(journey),
          renderJourney(journey),
        );
        ops.addBlocker({ id: randomId(), cardId, blockedByCardId: primaryCardId });
        cards.push({ cardId, title: journey.action, phase: 1, blockedBy: [primaryCardId] });
      });

      return { epicId, primaryCardId, cards };
    },

    validatePhaseOrder: async ({ epicId }) => ops.validateAndSaveOrder(epicId),
  };
}

// ---------------------------------------------------------------------------
// Implementation session
// ---------------------------------------------------------------------------

export interface AutopilotSessionOps {
  /**
   * Start a bounded, auto-shipping implementation session for a card under the
   * run's authorized identity (owner-scoped credentials + worker key) and
   * return its session id. Implemented in index.ts over the real dispatch
   * triad (createSession + auto-ship/owner metadata + handleChat).
   */
  startImplementationSession: (args: {
    projectId: string;
    runId: string;
    operationId: string;
    cardId: string;
    workerKeyName: string | null;
    prompt: string;
  }) => Promise<{ sessionId: string }>;
}

export interface AutopilotSessionAdapterDeps {
  ops: AutopilotSessionOps;
}

/** Build the structured handoff prompt a baseline implementation worker receives. */
export function buildImplementationPrompt(context: AutopilotImplementationContext): string {
  const lines = [
    'You are an Autopilot implementation worker. Deliver the baseline for this card.',
    '',
    'Acceptance journeys (each must work in a browser-testable main flow):',
    ...context.acceptanceJourneys.map(
      (j) => `- When a user ${j.action}, then ${j.expectedResult}.`,
    ),
    '',
    'Non-goals (do not build these):',
    ...context.nonGoals.map((n) => `- ${n}`),
    '',
    'Locked spec decisions:',
    ...context.specDecisions.map((d) => `- ${d.key}: ${d.decision}`),
    '',
    'Storage recovery contract (code rollback cannot restore data). Use only the',
    'closed token; do not infer recoverability from the storage decision text:',
    context.storageRecovery ?? 'unknown',
    '',
    'Commit your work locally on the session branch. Do not push, open a PR, or',
    'merge — the platform Finalize flow owns review, CI, push and merge.',
  ];
  return lines.join('\n');
}

/** Dispatch a bounded implementation session with structured handoff context. */
export function createAutopilotSessionAdapter(
  deps: AutopilotSessionAdapterDeps,
): AutopilotSessionPort {
  return {
    dispatchImplementation: async ({
      projectId,
      runId,
      operationId,
      cardId,
      workerKeyName,
      context,
    }) =>
      deps.ops.startImplementationSession({
        projectId,
        runId,
        operationId,
        cardId,
        workerKeyName,
        prompt: buildImplementationPrompt(context),
      }),
  };
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

export interface AutopilotEvaluateOps {
  startEvaluationSession: (args: {
    projectId: string;
    runId: string;
    operationId: string;
    deploymentId: string;
    expectedSha: string;
    origin: string;
    workerKeyName: string | null;
    prompt: string;
  }) => Promise<{ sessionId: string }>;
}

export interface AutopilotEvaluateAdapterDeps {
  ops: AutopilotEvaluateOps;
}

/** Structured handoff the evaluator worker receives. Not an implementation brief. */
export function buildEvaluationPrompt(input: {
  origin: string;
  expectedSha: string;
  pinned: AutopilotPinnedCriteria;
}): string {
  return [
    'You are an Autopilot evaluator. You have no implementation write authority.',
    'Do not edit files, commit, push, or change tests, the brief, or evaluator policy.',
    '',
    `Evaluate the LIVE local deployment at ${input.origin}.`,
    `The deployed revision MUST be ${input.expectedSha}.`,
    'Do not use session preview. HTTP health alone is not sufficient.',
    'Use the local-target browser worker pinned to that origin.',
    '',
    'Pinned criteria (frozen before implementation):',
    ...input.pinned.criteria.map((c) => {
      const assertion =
        c.kind === 'api_check' && c.apiAssertion
          ? ` Assert ${JSON.stringify(c.apiAssertion)}.`
          : '';
      const request =
        c.kind === 'api_check' && c.apiRequest?.body
          ? ` Hub request ${c.apiRequest.method} body ${c.apiRequest.body}.`
          : '';
      return `- ${c.id} [${c.source}/${c.kind}]: When a user ${c.action}, then ${c.expectedResult}.${assertion}${request}`;
    }),
    '',
    'The Hub records screenshots and journey traces (the interaction sequence, not a final-page snapshot) when you use the local-target browser worker.',
    'Citing a path Hub did not capture for this operation is not evidence.',
    'Do not invent API status codes. Hub records HTTP responses itself.',
    'A 2xx at the named endpoint is not a pass; passed:false when the body does not show the expected result.',
    '',
    'Return ONLY a fenced ```json block:',
    '{',
    `  "expectedSha": "${input.expectedSha}",`,
    '  "observedSha": "<sha reported by the live target>",',
    `  "origin": "${input.origin}",`,
    '  "healthCheck": { "url": "...", "ok": true },',
    '  "capturedAt": "<ISO-8601 now>",',
    '  "usedPreview": false,',
    '  "criteria": [',
    '    { "criterionId": "baseline-1", "passed": true, "kind": "browser_journey",',
    '      "screenshotPath": "/path/shot.png", "tracePath": "/path/trace.zip",',
    '      "observed": "the list showed the new item" }',
    '  ]',
    '}',
    'Return pass/fail observations only. Subjective claims are rejected.',
  ].join('\n');
}

export function createAutopilotEvaluateAdapter(
  deps: AutopilotEvaluateAdapterDeps,
): AutopilotEvaluatePort {
  return {
    dispatchEvaluation: async (input) =>
      deps.ops.startEvaluationSession({
        projectId: input.projectId,
        runId: input.runId,
        operationId: input.operationId,
        workerKeyName: input.workerKeyName,
        prompt: buildEvaluationPrompt({
          origin: input.origin,
          expectedSha: input.expectedSha,
          pinned: input.pinned,
        }),
        deploymentId: input.deploymentId,
        expectedSha: input.expectedSha,
        origin: input.origin,
      }),
  };
}

// ---------------------------------------------------------------------------
// Finalize
// ---------------------------------------------------------------------------

export interface AutopilotFinalizeOps {
  /**
   * Set the session's automation level to "merge" (review -> CI -> push ->
   * merge) and start a Finalize run under an authorized identity. Returns the
   * finalize run id, or throws on a validation failure.
   */
  startMergeAutomation: (args: {
    projectId: string;
    sessionId: string;
    cardId: string;
  }) => Promise<{ finalizeRunId: string }>;
}

export interface AutopilotFinalizeAdapterDeps {
  ops: AutopilotFinalizeOps;
}

/** Invoke the existing Finalize automation for the implementation session. */
export function createAutopilotFinalizeAdapter(
  deps: AutopilotFinalizeAdapterDeps,
): AutopilotFinalizePort {
  return {
    startFinalize: async ({ projectId, sessionId, cardId }) =>
      deps.ops.startMergeAutomation({ projectId, sessionId, cardId }),
  };
}

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

export interface AutopilotDeployOps {
  startDeployment: (args: {
    projectId: string;
    runId: string;
    operationId: string;
    targetId: string;
    sha: string;
    sourceDeploymentId?: string | null;
    trigger: 'autopilot' | 'rollback';
  }) => Promise<{ deploymentId: string }>;
  /**
   * Await a rollback to a terminal outcome. Tests inject an immediate result;
   * production awaits the orchestrator without deferRun.
   */
  runRollback: (args: {
    projectId: string;
    runId: string;
    operationId: string;
    targetId: string;
    priorDeploymentId: string;
    priorSha: string;
  }) => Promise<AutopilotDeployResult>;
}

export interface AutopilotDeployAdapterDeps {
  ops: AutopilotDeployOps;
}

export interface DeploymentSnapshot {
  status: string;
  ref: string | null;
  liveRef?: string | null;
}

const DEPLOY_IN_FLIGHT = new Set(['pending', 'running']);

/** Live `current_ref` only. The requested deployment `ref` is not evidence. */
function establishedLiveRef(snap: DeploymentSnapshot): string | null {
  if (typeof snap.liveRef !== 'string') return null;
  const live = snap.liveRef.trim();
  return live.length > 0 ? live : null;
}

export function deployOutcomeFromSnapshot(
  deploymentId: string,
  snap: DeploymentSnapshot | null,
): AutopilotDeployResult | null {
  if (!snap) return null;
  if (DEPLOY_IN_FLIGHT.has(snap.status)) return null;
  if (snap.status === 'success') {
    const deployedSha = establishedLiveRef(snap);
    if (!deployedSha) return null;
    return { status: 'success', deploymentId, deployedSha };
  }
  if (snap.status === 'awaiting_approval') {
    return {
      status: 'awaiting_approval',
      deploymentId,
      deployedSha: snap.ref,
      message: 'deployment parked for approval',
    };
  }
  if (snap.status === 'cancelled') {
    return { status: 'cancelled', deploymentId, deployedSha: snap.ref };
  }
  return { status: 'error', deploymentId, deployedSha: snap.ref, message: snap.status };
}

export function createAutopilotDeployAdapter(
  deps: AutopilotDeployAdapterDeps,
): AutopilotDeployPort {
  return {
    deployRevision: async (input) =>
      deps.ops.startDeployment({
        projectId: input.projectId,
        runId: input.runId,
        operationId: input.operationId,
        targetId: input.targetId,
        sha: input.sha,
        trigger: 'autopilot',
      }),
    rollback: async (input) => deps.ops.runRollback(input),
  };
}

/**
 * Read a Finalize run's outcome into the orchestrator's result shape. Returns
 * null while the run is still in progress so the runtime re-checks next tick.
 * A `pushed` run whose PR merged with an approved review is a `merged` result;
 * a `changes_requested` verdict is a review rejection; other terminal states
 * are surfaced as ci_failed / error.
 */
export interface FinalizeRunSnapshot {
  status: string;
  reviewerVerdict: 'approved' | 'changes_requested' | null;
  merged: boolean;
  mergedSha: string | null;
}

const FINALIZE_TERMINAL = new Set([
  'pushed',
  'succeeded',
  'failed',
  'timed_out',
  'infra_error',
  'cancelled',
  'stalled_no_response',
]);

export function finalizeOutcomeFromSnapshot(
  snap: FinalizeRunSnapshot | null,
): AutopilotFinalizeResult | null {
  if (!snap) return null;
  if (!FINALIZE_TERMINAL.has(snap.status)) return null; // still running
  if (snap.reviewerVerdict === 'changes_requested') {
    return { status: 'review_rejected', reviewStatus: 'changes_requested' };
  }
  // A merged result may only be reported as approved when the reviewer actually
  // approved. A merge that lands without an 'approved' verdict must NOT
  // manufacture reviewer evidence — it falls through to `error` so downstream
  // reconciliation cannot advance the cycle on it.
  if (
    (snap.status === 'pushed' || snap.status === 'succeeded') &&
    snap.merged &&
    snap.mergedSha &&
    snap.reviewerVerdict === 'approved'
  ) {
    return { status: 'merged', mergedSha: snap.mergedSha, reviewStatus: 'approved' };
  }
  if (snap.status === 'failed' || snap.status === 'timed_out' || snap.status === 'infra_error') {
    return { status: 'ci_failed', reviewStatus: snap.reviewerVerdict };
  }
  return { status: 'error', reviewStatus: snap.reviewerVerdict, message: snap.status };
}
