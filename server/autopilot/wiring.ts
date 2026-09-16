import path from 'path';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import type { RouteDeps, Stmts, SessionRow, Project, FinalizeRunRow } from '../types.js';
import { getDb } from '../db.js';
import config from '../config.js';
import { getOrCreateBoard } from '../routes/board.js';
import { findCycle } from '../kanban-blockers.js';
import { topologicallySortPhaseIds, PhaseCycleError } from '../kanban-phase-topo-sort.js';
import { ensureKanbanCardForSession } from '../finalize/ensure-kanban-card.js';
import { POST_FINALIZE_PUSH_LOCK_ERROR } from '../finalize/post-push-session-lock.js';
import {
  startFinalizeRunBackground,
  type StartFinalizeRunBackgroundResult,
} from '../finalize/trigger-run.js';
import { markSessionFinalizeAutomation } from '../session-ship.js';
import { setSessionOwner } from '../session-ownership.js';
import { finalizeTurnEndSubscriber, subscribeAllTurnEnds } from '../finalize/turn-end.js';
import { writeSpawnCredsFile } from '../spawn-creds-file.js';
import { bindAutopilotWorkerSession, readAutopilotWorkerToken } from './worker-token.js';
import { upsertPage } from '../wiki.js';
import { getArtifactStore, buildArtifactKey } from '../artifacts/artifact-store.js';
import { stableAutopilotArtifactId } from './document.js';
import {
  createAutopilotBoardAdapter,
  createAutopilotDeployAdapter,
  createAutopilotDocumentAdapter,
  createAutopilotEvaluateAdapter,
  createAutopilotFinalizeAdapter,
  createAutopilotPlannerAdapter,
  createAutopilotSessionAdapter,
  deployOutcomeFromSnapshot,
  finalizeOutcomeFromSnapshot,
  type AutopilotBoardOps,
  type AutopilotDeployOps,
  type AutopilotDocumentOps,
  type AutopilotEvaluateOps,
  type AutopilotFinalizeOps,
  type AutopilotPlannerOps,
  type AutopilotSessionOps,
} from './adapters.js';
import { buildAutopilotControllerDeps, type AutopilotRouteOptions } from '../routes/autopilot.js';
import { createAutopilotController } from './controller.js';
import { AutopilotStore } from './store.js';
import { createAutopilotRuntime, type AutopilotRuntime } from './runtime.js';
import type {
  AutopilotDeployResult,
  AutopilotFinalizeResult,
  AutopilotSessionResult,
} from './orchestrator.js';
import { parseEvaluationReport, type AutopilotEvaluationReport } from './evaluate.js';
import { describeSelectedImprovement } from './select.js';
import { listEvaluationCaptures, probePinnedApiCriterion } from './evaluation-captures.js';
import type { AutopilotRunRecord, AutopilotIsolationAdapter } from './types.js';
import { getDeployment, getDeploymentEnvironment } from '../deploy/deployment-store.js';
import { triggerDeployment } from '../deploy/deploy-orchestrator.js';
import { loadDeployConfig, parseDeployConfig } from '../deploy/deploy-config.js';
import { prepareDeploymentCheckout } from '../deploy/deployment-checkout.js';
import { buildDeployOrchestratorDeps } from '../deploy/deploy-trigger-hook.js';

const AUTOPILOT_KEY_LABEL = 'autopilot-key:';
const AUTOPILOT_CARD_LABEL = 'autopilot-card:';

/** Session titles Autopilot workers appear under in the sidebar. */
export function autopilotWorkerSessionName(input: {
  role: 'implementer' | 'evaluator';
  cycleNumber: number;
  cardTitle?: string | null;
  selectedImprovement?: string | null;
}): string {
  if (input.role === 'evaluator') {
    return `Autopilot evaluator · cycle ${input.cycleNumber}`;
  }
  const selected = describeSelectedImprovement(input.selectedImprovement);
  if (selected) return `Autopilot: ${selected}`.slice(0, 120);
  const card = input.cardTitle?.trim();
  return card || 'Autopilot implementation';
}

interface KanbanEpicLite {
  id: string;
  labels: string | null;
}
interface KanbanCardLite {
  id: string;
  title: string;
  labels: string | null;
  phase_id: string | null;
  position: number;
}

/** Extract the durable Autopilot card key from a card's labels, if present. */
function autopilotCardKey(labels: string | null): string | null {
  if (!labels) return null;
  for (const label of labels.split(',')) {
    const trimmed = label.trim();
    if (trimmed.startsWith(AUTOPILOT_CARD_LABEL)) {
      return trimmed.slice(AUTOPILOT_CARD_LABEL.length);
    }
  }
  return null;
}

/** Cycle-scoped phase identity stored in the kanban phase description. */
function autopilotPhaseKey(description: string | null | undefined): string | null {
  if (!description) return null;
  const idx = description.indexOf(AUTOPILOT_KEY_LABEL);
  if (idx < 0) return null;
  const token =
    description
      .slice(idx + AUTOPILOT_KEY_LABEL.length)
      .trim()
      .split(/\s/)[0] ?? '';
  return token || null;
}
interface FinalizeRunLite {
  status: string;
  reviewer_verdict: 'approved' | 'changes_requested' | null;
  pr_url: string | null;
  project_id: string;
  ended_at: number | null;
}
interface PullRequestLite {
  status: string;
  merged_sha: string | null;
}

function prNumberFromUrl(url: string): number | null {
  const m = url.match(/(\d+)(?:\/?)$/);
  return m ? Number(m[1]) : null;
}

/**
 * Extract a baseline-spec JSON object from a planning session's assistant
 * output (a fenced ```json block or the first balanced object). Returns null
 * when no parseable object is present; the adapter's validateBaselineSpec then
 * rejects it so planning retries rather than persisting garbage. Pure + tested.
 */
export function parseBaselineSpecJson(text: string): unknown {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function buildPlanningPrompt(brief: string): string {
  return [
    'You are the Autopilot planner. Resolve the loose brief below into a small,',
    'concrete, testable baseline. Do NOT restate the brief verbatim.',
    '',
    'Brief:',
    brief,
    '',
    'Return ONLY a fenced ```json block with this exact shape:',
    '{',
    '  "assumptions": string[],           // inferred, non-empty',
    '  "acceptanceJourneys": [            // each a CONCRETE end-user action + observable result',
    '    { "action": "submit a new todo via the add form",',
    '      "expectedResult": "the new item appears in the todo list" }',
    '  ],',
    '  "nonGoals": string[],              // non-empty',
    '  "specDecisions": [ { "key": "storage", "decision": "..." }, { "key": "runtime", "decision": "..." } ],',
    '  "storageRecovery": "disposable" | "backward-compatible" | "unsupported" | "unknown",',
    '  "qualityRubricVersion": 1',
    '}',
    'Resolve scope conflicts and the storage choice concretely before returning.',
    'storageRecovery is a closed token, not a sentence. Do not infer it from',
    'the storage decision text. Only disposable (throwaway test data) and',
    'backward-compatible (a code rollback leaves data intact) are accepted.',
    'unsupported and unknown fail planning and never authorize deploy, including',
    'the first cycle: lacking a last-known-good artifact does not establish that',
    'the target holds disposable data.',
  ].join('\n');
}

/**
 * Pin a worker session's session-env adapter to the project's chosen isolation
 * adapter, failing closed. `auto` is a no-op (the global boot selection applies).
 *
 * For any concrete adapter the UPDATE MUST affect exactly the target session; if
 * it does not, the worker would silently run under the global adapter that the
 * controller's containment gate did not approve (e.g. a Sysbox selection that
 * passed the gate but reverts to the host default). The caller must abort
 * dispatch, so this throws rather than logging and continuing.
 */
export function pinSessionEnvAdapter(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  isolationAdapter: AutopilotIsolationAdapter,
): void {
  if (!isolationAdapter || isolationAdapter === 'auto') return;
  const result = db
    .prepare('UPDATE sessions SET session_env_adapter = ? WHERE id = ?')
    .run(isolationAdapter, sessionId);
  if (result.changes !== 1) {
    throw new Error(
      `autopilot: failed to pin session-env adapter '${isolationAdapter}' on session ` +
        `${sessionId} (rows changed=${result.changes}); refusing to dispatch a worker whose ` +
        `isolation would diverge from the approved selection`,
    );
  }
}

function bindWorkerSession(
  sessionId: string,
  projectId: string,
  runId: string,
  role: 'implementer' | 'evaluator' = 'implementer',
  origin: string | null = null,
  extra: {
    operationId?: string | null;
    deploymentId?: string | null;
    expectedSha?: string | null;
  } = {},
): void {
  bindAutopilotWorkerSession(
    sessionId,
    {
      projectId,
      runId,
      role,
      origin,
      operationId: extra.operationId ?? null,
      deploymentId: extra.deploymentId ?? null,
      expectedSha: extra.expectedSha ?? null,
    },
    config.dataDir,
  );
  // Pin the project's chosen isolation adapter onto the worker session so the
  // worker runs under the adapter the controller's containment gate approved,
  // even when the server's global adapter differs. Fails closed.
  pinSessionEnvAdapter(
    getDb(),
    sessionId,
    new AutopilotStore(getDb()).getConfig(projectId).isolationAdapter,
  );
  const token = readAutopilotWorkerToken(runId, config.dataDir, role);
  if (token) {
    try {
      writeSpawnCredsFile(sessionId, token, config.dataDir);
    } catch (err) {
      console.warn(
        `[autopilot] spawn-creds write failed session=${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * Build the real planner ops: dispatch a bounded planning session under the
 * run's owner-scoped identity, await its turn, and parse the structured
 * baseline it emits. The adapter validates the result; an unparseable or
 * incomplete result fails planning (which the controller retries/pauses).
 */
export function buildPlannerOps(deps: AutopilotWiringDeps): AutopilotPlannerOps {
  const { routeDeps, resolveWorkerAgent } = deps;
  const stmts = routeDeps.stmts;
  return {
    planBaseline: async ({ projectId, runId, brief }) => {
      const agent = resolveWorkerAgent(projectId);
      if (!agent) throw new Error(`Autopilot: no worker agent configured for project ${projectId}`);
      const store = new AutopilotStore(getDb());
      const run = store.getRun(runId);
      const sessionId = randomUUID();
      stmts.createSession.run(
        sessionId,
        agent.agentId,
        'Autopilot planning',
        agent.engine,
        agent.model,
        1,
        0,
        0,
      );
      setSessionOwner(sessionId, run?.credentialOwnerUserId ?? null);
      bindWorkerSession(sessionId, projectId, runId);
      const planningOp = store
        .listInFlightOperations(runId)
        .find((op) => op.kind === 'plan-baseline');
      if (planningOp) store.updateOperation(planningOp.id, { sessionId });
      const turnEnded = new Promise<void>((resolve) => {
        const unsub = finalizeTurnEndSubscriber.subscribe(sessionId, () => {
          unsub();
          resolve();
        });
      });
      await routeDeps.handleChat(null, {
        type: 'chat',
        agentId: agent.agentId,
        sessionId,
        content: buildPlanningPrompt(brief),
        _fromAutonomousDispatch: true,
      } as never);
      await turnEnded;
      const msg = stmts.getLastAssistantMessage.get(sessionId) as { content?: string } | undefined;
      return parseBaselineSpecJson(msg?.content ?? '');
    },
  };
}

/** Build the real board ops backed by the kanban prepared statements. */
export function buildBoardOps(stmts: Stmts): AutopilotBoardOps {
  return {
    ensureBoard: (projectId) => {
      const { board } = getOrCreateBoard(stmts, projectId, { includeCards: false });
      return { boardId: board.id };
    },
    todoColumnId: (boardId) => {
      const cols = stmts.getKanbanColumns.all(boardId) as { id: string; name: string }[];
      return cols.find((c) => c.name.toLowerCase() === 'to do')?.id ?? cols[0]?.id ?? '';
    },
    findEpicByKey: (boardId, key) => {
      const epics = stmts.getKanbanEpics.all(boardId) as KanbanEpicLite[];
      const hit = epics.find((e) => (e.labels ?? '').includes(`${AUTOPILOT_KEY_LABEL}${key}`));
      return hit ? { epicId: hit.id } : null;
    },
    createEpic: (a) =>
      stmts.createKanbanEpic.run(
        a.id,
        a.boardId,
        a.name,
        a.description,
        '#6366F1',
        a.position,
        a.labels,
      ),
    nextEpicPosition: (boardId) => {
      const epics = stmts.getKanbanEpics.all(boardId) as { position: number }[];
      return epics.length ? Math.max(...epics.map((e) => e.position)) + 1 : 0;
    },
    ensurePhase: (a) => {
      const phases = stmts.getKanbanPhasesByEpic.all(a.epicId) as { id: string }[];
      if (phases[0]) return { phaseId: phases[0].id };
      const phaseId = randomUUID();
      stmts.createKanbanPhase.run(phaseId, a.epicId, a.boardId, 'Baseline', null, 0);
      return { phaseId };
    },
    listCardsForEpic: (epicId) =>
      (stmts.getKanbanCardsByEpic.all(epicId) as KanbanCardLite[])
        .map((c) => ({ id: c.id, key: autopilotCardKey(c.labels) }))
        .filter((c): c is { id: string; key: string } => c.key != null),
    createCard: (a) => {
      stmts.createKanbanCard.run(
        a.id,
        a.columnId,
        a.boardId,
        a.title,
        a.description,
        'medium',
        null,
        `${AUTOPILOT_CARD_LABEL}${a.key}`,
        null,
        null,
        null,
        null,
        a.position,
      );
      stmts.updateKanbanCardEpic.run(a.epicId, a.id);
      stmts.updateKanbanCardPhase.run(a.phaseId, a.id);
    },
    nextCardPosition: (columnId) => {
      const cards = stmts.getKanbanCardsByColumn.all(columnId) as { position: number }[];
      return cards.length ? Math.max(...cards.map((c) => c.position)) + 1 : 0;
    },
    addBlocker: (a) => {
      // Idempotent: skip if the edge already exists, and never create a cycle.
      if (stmts.getBlocker.get(a.cardId, a.blockedByCardId)) return;
      if (findCycle(stmts, a.cardId, a.blockedByCardId)) return;
      stmts.createBlocker.run(a.id, a.cardId, a.blockedByCardId);
    },
    listPhases: (epicId) =>
      (
        stmts.getKanbanPhasesByEpic.all(epicId) as {
          id: string;
          name: string;
          position: number;
          description?: string | null;
        }[]
      ).map((p) => ({
        id: p.id,
        name: p.name,
        position: p.position,
        key: autopilotPhaseKey(p.description),
      })),
    createPhase: (a) => {
      const description = a.key ? `${AUTOPILOT_KEY_LABEL}${a.key}` : null;
      stmts.createKanbanPhase.run(a.id, a.epicId, a.boardId, a.name, description, a.position);
    },
    transaction: (fn) => getDb().transaction(fn)(),
    listEpicCards: (epicId) => {
      const cards = stmts.getKanbanCardsByEpic.all(epicId) as (KanbanCardLite & {
        column_id?: string;
        phase_id: string | null;
      })[];
      return cards.map((c) => {
        const col = c.column_id
          ? (stmts.getKanbanColumn.get(c.column_id) as { name?: string } | undefined)
          : undefined;
        return {
          id: c.id,
          key: autopilotCardKey(c.labels),
          phaseId: c.phase_id,
          columnName: col?.name ?? '',
        };
      });
    },
    validateAndSaveOrder: (epicId) => {
      const phases = stmts.getKanbanPhasesByEpic.all(epicId) as { id: string; position: number }[];
      const cards = stmts.getKanbanCardsByEpic.all(epicId) as KanbanCardLite[];
      const cardIds = new Set(cards.map((c) => c.id));
      const boardId =
        (stmts.getKanbanCard.get(cards[0]?.id) as { board_id?: string } | undefined)?.board_id ??
        null;
      const edges = boardId
        ? (
            stmts.getBlockersForBoard.all(boardId) as {
              card_id: string;
              blocked_by_card_id: string;
            }[]
          ).filter((e) => cardIds.has(e.card_id))
        : [];
      try {
        const ordered = topologicallySortPhaseIds(
          phases.map((p) => ({ id: p.id, position: p.position })),
          cards.map((c) => ({ id: c.id, phase_id: c.phase_id ?? null })),
          edges,
        );
        getDb().transaction(() => {
          ordered.forEach((id, i) => stmts.setKanbanPhasePosition.run(i, id));
        })();
        return { ok: true };
      } catch (err) {
        if (err instanceof PhaseCycleError) {
          return { ok: false, reason: `phase cycle: ${err.cyclePhaseIds.join(' -> ')}` };
        }
        throw err;
      }
    },
  };
}

/** Read a Finalize run + its PR into the orchestrator's result shape. */
export function readFinalizeOutcome(
  stmts: Stmts,
  finalizeRunId: string,
): AutopilotFinalizeResult | null {
  const run = stmts.getFinalizeRun.get(finalizeRunId) as FinalizeRunLite | undefined;
  if (!run) return null;
  let merged = false;
  let mergedSha: string | null = null;
  if (run.pr_url) {
    const number = prNumberFromUrl(run.pr_url);
    if (number != null) {
      const pr = stmts.getPullRequestByNumber.get(run.project_id, number) as
        | PullRequestLite
        | undefined;
      if (pr) {
        merged = pr.status === 'merged';
        mergedSha = pr.merged_sha;
      }
    }
  }
  return finalizeOutcomeFromSnapshot({
    status: run.status,
    reviewerVerdict: run.reviewer_verdict,
    merged,
    mergedSha,
    endedAt: run.ended_at,
  });
}

export type AutopilotStartFinalizeRun = (
  deps: RouteDeps,
  args: {
    project: Project;
    card: import('../types.js').KanbanCardRow;
    session: SessionRow;
    triggerSource?: 'ui_button' | 'agent_block';
    triggeredByUserId?: string;
  },
) => Promise<StartFinalizeRunBackgroundResult>;

/** Build the real Finalize ops (set merge automation + start the run). */
export function buildFinalizeOps(
  deps: RouteDeps,
  startRun: AutopilotStartFinalizeRun = startFinalizeRunBackground,
): AutopilotFinalizeOps {
  return {
    startMergeAutomation: async ({ projectId, sessionId }) => {
      const session = deps.stmts.getSession.get(sessionId) as SessionRow | undefined;
      if (!session) throw new Error(`Autopilot: session ${sessionId} not found for Finalize`);
      const project = deps.findProject(projectId);
      if (!project) throw new Error(`Autopilot: project ${projectId} not found for Finalize`);
      const existingPushedRun = () => {
        const pushed = deps.stmts.getPushedFinalizeRunForSession.get(sessionId) as
          | FinalizeRunRow
          | undefined;
        if (pushed && pushed.project_id !== projectId) {
          throw new Error('Autopilot: pushed Finalize run belongs to another project');
        }
        return pushed ? { finalizeRunId: pushed.id } : null;
      };
      // A pushed session is locked. Reconcile its existing run on retry/resume
      // without changing automation or launching Finalize again.
      const pushed = existingPushedRun();
      if (pushed) return pushed;
      markSessionFinalizeAutomation(deps.stmts, sessionId, 'merge');
      const { card } = ensureKanbanCardForSession(
        { stmts: deps.stmts, broadcast: deps.broadcast, findAgent: deps.findAgent },
        { projectId, session, createdBy: null },
      );
      const res = await startRun(deps, {
        project: project as Project,
        card,
        session,
        triggeredByUserId: 'autopilot',
      });
      if (!res.ok && res.error === POST_FINALIZE_PUSH_LOCK_ERROR) {
        const pushedDuringStart = existingPushedRun();
        if (pushedDuringStart) return pushedDuringStart;
      }
      if (!res.ok || !res.runId) {
        throw new Error(`Autopilot: Finalize did not start (${res.ok ? 'no runId' : res.error})`);
      }
      return { finalizeRunId: res.runId };
    },
  };
}

export type AutopilotStartDeployment = (args: {
  projectId: string;
  runId: string;
  operationId: string;
  targetId: string;
  sha: string;
  sourceDeploymentId?: string | null;
  trigger: 'autopilot' | 'rollback';
}) => Promise<{ deploymentId: string }>;

export type AutopilotRunRollback = (args: {
  projectId: string;
  runId: string;
  operationId: string;
  targetId: string;
  priorDeploymentId: string;
  priorSha: string;
}) => Promise<AutopilotDeployResult>;

/** Read a deployment row + live env ref into the orchestrator result shape. */
export function readDeployOutcome(deploymentId: string): AutopilotDeployResult | null {
  const row = getDeployment(deploymentId);
  if (!row) return null;
  const live = getDeploymentEnvironment(row.project_id, row.environment);
  return deployOutcomeFromSnapshot(deploymentId, {
    status: row.status,
    ref: row.ref,
    liveRef: live?.current_ref ?? null,
  });
}

export function readAutopilotDeployedRevision(projectId: string, targetId: string): string | null {
  return getDeploymentEnvironment(projectId, targetId)?.current_ref ?? null;
}

export function buildLocalTargetLookup(
  findProject: (id: string) => Project | null | undefined,
  getLiveEnvironment: (
    projectId: string,
    targetId: string,
  ) => {
    current_ref: string | null;
    current_deployment_id: string | null;
  } | null = getDeploymentEnvironment,
): import('./local-target.js').AutopilotLocalTargetLookup {
  return {
    getDeclaredEnvironment: (projectId, targetId) => {
      const project = findProject(projectId);
      if (!project?.cwd) return null;
      try {
        const raw = readFileSync(path.join(project.cwd, '.agent-hub', 'deploy.yaml'), 'utf8');
        const env = parseDeployConfig(raw).environments.get(targetId);
        if (!env) return null;
        const live = getLiveEnvironment(projectId, targetId);
        return {
          origin: env.origin,
          readinessProbeUrl: env.readiness,
          currentRef: live?.current_ref ?? null,
          currentDeploymentId: live?.current_deployment_id ?? null,
        };
      } catch {
        return null;
      }
    },
  };
}

/** Build deploy ops. Tests inject startDeployment / runRollback so Vitest never hits a live target. */
export function buildDeployOps(
  deps: AutopilotWiringDeps,
  startDeployment: AutopilotStartDeployment | undefined,
  runRollback: AutopilotRunRollback | undefined,
): AutopilotDeployOps {
  const kickoff: AutopilotStartDeployment = async (args) => {
    if (startDeployment) return startDeployment(args);
    const project = deps.routeDeps.findProject(args.projectId);
    if (!project) throw new Error(`Autopilot: project ${args.projectId} not found for deploy`);
    const checkout = await prepareDeploymentCheckout({ project, ref: args.sha });
    const cfg = await loadDeployConfig(
      path.join(checkout.worktreePath, '.agent-hub', 'deploy.yaml'),
    );
    const orchestratorDeps = buildDeployOrchestratorDeps({
      broadcast: deps.routeDeps.broadcast,
      config,
      findProject: deps.routeDeps.findProject,
      prepareCheckout: prepareDeploymentCheckout,
    });
    const row = await triggerDeployment(
      {
        projectId: args.projectId,
        environment: args.targetId,
        ref: args.sha,
        worktreePath: checkout.worktreePath,
        config: cfg,
        trigger: 'autopilot',
        triggeredBy: 'autopilot',
        sourceDeploymentId: args.sourceDeploymentId ?? null,
        unattendedEnvironment: args.targetId,
        deferRun: true,
        cleanupWorktreeOnTerminal: true,
        meta: { autopilotRunId: args.runId, operationId: args.operationId },
      },
      orchestratorDeps,
    );
    return { deploymentId: row.id };
  };
  return {
    startDeployment: kickoff,
    runRollback: async (args) => {
      if (runRollback) return runRollback(args);
      const project = deps.routeDeps.findProject(args.projectId);
      if (!project) throw new Error(`Autopilot: project ${args.projectId} not found for rollback`);
      const checkout = await prepareDeploymentCheckout({ project, ref: args.priorSha });
      const cfg = await loadDeployConfig(
        path.join(checkout.worktreePath, '.agent-hub', 'deploy.yaml'),
      );
      const orchestratorDeps = buildDeployOrchestratorDeps({
        broadcast: deps.routeDeps.broadcast,
        config,
        findProject: deps.routeDeps.findProject,
        prepareCheckout: prepareDeploymentCheckout,
      });
      const row = await triggerDeployment(
        {
          projectId: args.projectId,
          environment: args.targetId,
          ref: args.priorSha,
          worktreePath: checkout.worktreePath,
          config: cfg,
          trigger: 'autopilot',
          triggeredBy: 'autopilot',
          sourceDeploymentId: args.priorDeploymentId,
          unattendedEnvironment: args.targetId,
          deferRun: false,
          cleanupWorktreeOnTerminal: true,
          meta: {
            autopilotRunId: args.runId,
            operationId: args.operationId,
            rollbackOf: args.priorDeploymentId,
          },
        },
        orchestratorDeps,
      );
      const live = getDeploymentEnvironment(args.projectId, args.targetId);
      const liveRef = live?.current_ref ?? null;
      return (
        deployOutcomeFromSnapshot(row.id, {
          status: row.status,
          ref: row.ref,
          liveRef,
        }) ?? {
          status: 'error',
          deploymentId: row.id,
          deployedSha: liveRef,
          message: liveRef
            ? 'rollback did not reach a terminal state'
            : 'live revision is not established',
        }
      );
    },
  };
}

/** Read a dispatched session's outcome (committed locally?) via its worktree. */
export function readSessionOutcome(
  stmts: Stmts,
  activeSessionIds: Set<string>,
  sessionId: string,
): AutopilotSessionResult | null {
  if (activeSessionIds.has(sessionId)) return null; // still running its turn
  const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
  if (!session) return { committed: false, error: 'session missing' };
  // A finished autonomous session that shipped records changes_ready / a pushed
  // branch; treat a recorded changes_ready blob or a non-null worktree branch
  // with committed work as "committed locally".
  const changesReady = (session as { changes_ready?: string | null }).changes_ready ?? null;
  if (changesReady) return { committed: true };
  if (session.code_changed_at) return { committed: true };
  // Turn is over and the worker did not leave local commits. Waiting forever
  // for changes_ready re-dispatches the same baseline card on stage timeout.
  return { committed: true, alreadyDelivered: true };
}

export function readEvaluateOutcome(
  stmts: Stmts,
  activeSessionIds: Set<string>,
  sessionId: string,
): AutopilotEvaluationReport | null {
  if (activeSessionIds.has(sessionId)) return null;
  const msg = stmts.getLastAssistantMessage.get(sessionId) as { content?: string } | undefined;
  if (!msg?.content) return null;
  return parseEvaluationReport(parseBaselineSpecJson(msg.content));
}

export interface AutopilotWorkerAgent {
  agentId: string;
  engine: string;
  model: string;
}

export interface AutopilotWiringDeps {
  routeDeps: RouteDeps;
  /** Resolve the agent that runs Autopilot implementation sessions for a project. */
  resolveWorkerAgent: (projectId: string) => AutopilotWorkerAgent | null;
  /** Active chat session ids (a session mid-turn is not yet done). */
  getActiveSessionIds: () => Set<string>;
  controllerOptions?: AutopilotRouteOptions;
  /**
   * Optional Finalize kickoff. Production omits this and uses
   * startFinalizeRunBackground. The canned Vitest fixture injects a
   * deterministic fake. The outside-Vitest integrated runner omits this so
   * the real Finalize path (review, native push, merge) can reconcile.
   */
  startFinalizeRun?: AutopilotStartFinalizeRun;
  /**
   * Optional deploy kickoff / rollback. Production omits these and uses
   * triggerDeployment. Vitest fixtures inject deterministic fakes so tests
   * never touch a live deployment.
   */
  startDeployment?: AutopilotStartDeployment;
  runRollback?: AutopilotRunRollback;
  readDeployOutcome?: (deploymentId: string) => AutopilotDeployResult | null;
}

/** Build the real session dispatch ops over the createSession + handleChat triad. */
export function buildSessionOps(deps: AutopilotWiringDeps): AutopilotSessionOps {
  const { routeDeps, resolveWorkerAgent } = deps;
  const stmts = routeDeps.stmts;
  return {
    startImplementationSession: async ({ projectId, runId, cardId, prompt }) => {
      const agent = resolveWorkerAgent(projectId);
      if (!agent) {
        throw new Error(`Autopilot: no worker agent configured for project ${projectId}`);
      }
      const store = new AutopilotStore(getDb());
      const run = store.getRun(runId);
      const ownerUserId = run?.credentialOwnerUserId ?? null;
      const card = stmts.getKanbanCard.get(cardId) as { id: string; title: string } | undefined;
      const cycle = run ? store.getCycle(run.id, run.cycleNumber) : null;
      const sessionId = randomUUID();
      // createSession(id, agentId, name, engine, model, use_worktree, ask_mode, wiki_budget)
      stmts.createSession.run(
        sessionId,
        agent.agentId,
        autopilotWorkerSessionName({
          role: 'implementer',
          cycleNumber: cycle?.cycleNumber ?? run?.cycleNumber ?? 1,
          cardTitle: card?.title,
          selectedImprovement: cycle?.selectedImprovement,
        }),
        agent.engine,
        agent.model,
        1,
        0,
        0,
      );
      setSessionOwner(sessionId, ownerUserId);
      bindWorkerSession(sessionId, projectId, runId);
      // Commit locally only. Auto-ship would push/PR and skip Autopilot's
      // Finalize adapter; Finalize is driven by the controller instead.
      markSessionFinalizeAutomation(stmts, sessionId, 'manual');
      // Link the primary card to this session so Finalize acts on the same card.
      getDb().prepare('UPDATE kanban_cards SET session_id = ? WHERE id = ?').run(sessionId, cardId);
      void routeDeps
        .handleChat(null, {
          type: 'chat',
          agentId: agent.agentId,
          sessionId,
          content: prompt,
          _fromAutonomousDispatch: true,
        } as never)
        .catch((err: unknown) =>
          console.error('[autopilot] implementation session', (err as Error).message),
        );
      return { sessionId };
    },
  };
}

/** Build evaluator session ops: consult mode, no worktree, evaluator worker key. */
export function buildEvaluateOps(deps: AutopilotWiringDeps): AutopilotEvaluateOps {
  const { routeDeps, resolveWorkerAgent } = deps;
  const stmts = routeDeps.stmts;
  return {
    startEvaluationSession: async ({
      projectId,
      runId,
      operationId,
      deploymentId,
      expectedSha,
      origin: boundOrigin,
      prompt,
    }) => {
      const agent = resolveWorkerAgent(projectId);
      if (!agent) {
        throw new Error(`Autopilot: no worker agent configured for project ${projectId}`);
      }
      const store = new AutopilotStore(getDb());
      const run = store.getRun(runId);
      const ownerUserId = run?.credentialOwnerUserId ?? null;
      const origin = (boundOrigin || store.getConfig(projectId).target?.origin) ?? null;
      const sessionId = randomUUID();
      stmts.createSession.run(
        sessionId,
        agent.agentId,
        autopilotWorkerSessionName({
          role: 'evaluator',
          cycleNumber: run?.cycleNumber ?? 1,
        }),
        agent.engine,
        agent.model,
        0,
        1,
        0,
      );
      stmts.updateSessionMode.run('consult', sessionId);
      setSessionOwner(sessionId, ownerUserId);
      bindWorkerSession(sessionId, projectId, runId, 'evaluator', origin, {
        operationId,
        deploymentId,
        expectedSha,
      });
      markSessionFinalizeAutomation(stmts, sessionId, 'manual');
      void routeDeps
        .handleChat(null, {
          type: 'chat',
          agentId: agent.agentId,
          sessionId,
          content: prompt,
          _fromAutonomousDispatch: true,
        } as never)
        .catch((err: unknown) =>
          console.error('[autopilot] evaluator session', (err as Error).message),
        );
      return { sessionId };
    },
  };
}

/**
 * Wiki/journal/artifact ops the documenting stage uses. Journal upserts are
 * idempotent; evidence is published as session artifacts with secrets already
 * stripped by the orchestrator.
 */
export function buildDocumentOps(routeDeps: RouteDeps): AutopilotDocumentOps {
  return {
    upsertPage: (projectId, input) => {
      upsertPage(projectId, {
        title: input.title,
        content: input.content,
        category: input.category,
        updatedBy: input.updatedBy,
      });
    },
    publishArtifact: async ({
      sessionId,
      cycleId,
      key: artifactKey,
      filename,
      contentType,
      body,
    }) => {
      const id = stableAutopilotArtifactId(cycleId, artifactKey);
      const existing = routeDeps.stmts.getArtifact.get(id) as { id: string } | undefined;
      if (existing) return { artifactId: existing.id };
      const store = getArtifactStore(config);
      const storageKey = buildArtifactKey(sessionId, id);
      const storageBucket = store.kind === 's3' ? config.artifactsBucket : null;
      const storageRegion = store.kind === 's3' ? config.artifactsBucketRegion : null;
      await store.put(storageKey, body, contentType);
      try {
        routeDeps.stmts.insertArtifact.run(
          id,
          sessionId,
          filename,
          contentType,
          body.length,
          store.kind,
          storageKey,
          storageBucket,
          storageRegion,
          'autopilot',
        );
      } catch (err) {
        const again = routeDeps.stmts.getArtifact.get(id) as { id: string } | undefined;
        if (again) return { artifactId: again.id };
        throw err;
      }
      return { artifactId: id };
    },
  };
}

export function buildAutopilotRuntime(deps: AutopilotWiringDeps): AutopilotRuntime {
  const { routeDeps } = deps;
  const stmts = routeDeps.stmts;
  const plannerOps = buildPlannerOps(deps);
  const boardOps = buildBoardOps(stmts);
  const finalizeOps = buildFinalizeOps(
    routeDeps,
    deps.startFinalizeRun ?? startFinalizeRunBackground,
  );
  const sessionOps = buildSessionOps(deps);
  const evaluateOps = buildEvaluateOps(deps);
  const deployOps = buildDeployOps(deps, deps.startDeployment, deps.runRollback);
  const documentOps = buildDocumentOps(routeDeps);
  return createAutopilotRuntime({
    db: getDb(),
    buildController: () =>
      createAutopilotController(buildAutopilotControllerDeps(deps.controllerOptions ?? {})),
    buildAdapters: (_run: AutopilotRunRecord) => ({
      planner: createAutopilotPlannerAdapter({ ops: plannerOps }),
      board: createAutopilotBoardAdapter({ ops: boardOps }),
      session: createAutopilotSessionAdapter({ ops: sessionOps }),
      finalize: createAutopilotFinalizeAdapter({ ops: finalizeOps }),
      deploy: createAutopilotDeployAdapter({ ops: deployOps }),
      evaluate: createAutopilotEvaluateAdapter({ ops: evaluateOps }),
      document: createAutopilotDocumentAdapter({ ops: documentOps }),
    }),
    readSessionOutcome: (sessionId) =>
      readSessionOutcome(stmts, deps.getActiveSessionIds(), sessionId),
    readFinalizeOutcome: (finalizeRunId) => readFinalizeOutcome(stmts, finalizeRunId),
    readDeployOutcome: deps.readDeployOutcome ?? readDeployOutcome,
    readEvaluateOutcome: (sessionId) =>
      readEvaluateOutcome(stmts, deps.getActiveSessionIds(), sessionId),
    listCaptures: (operationId) => listEvaluationCaptures(config.dataDir, operationId),
    probeApi: (input) => probePinnedApiCriterion(input),
  });
}

/**
 * Route session turn-end and Finalize/changes_ready broadcasts into the
 * runtime's reconcile methods. Returns an unsubscribe for tests.
 */
export function attachAutopilotCompletionCallbacks(runtime: AutopilotRuntime): () => void {
  return subscribeAllTurnEnds((sessionId) => {
    void runtime.settleSession(sessionId);
  });
}

export function handleAutopilotBroadcast(
  runtime: AutopilotRuntime,
  data: Record<string, unknown>,
): void {
  if (data.type === 'finalize_run_completed' && typeof data.run_id === 'string') {
    void runtime.settleFinalize(data.run_id);
  }
  if (data.type === 'changes_ready') {
    const sessionId = data.sessionId ?? data.session_id;
    if (typeof sessionId === 'string') void runtime.settleSession(sessionId);
  }
  if (data.type === 'deployment_update') {
    const deployment = data.deployment as { id?: string } | undefined;
    if (deployment && typeof deployment.id === 'string') {
      void runtime.settleDeployment(deployment.id);
    }
  }
}
