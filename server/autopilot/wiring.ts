import { randomUUID } from 'crypto';
import type { RouteDeps, Stmts, SessionRow, Project } from '../types.js';
import { getDb } from '../db.js';
import { getOrCreateBoard } from '../routes/board.js';
import { findCycle } from '../kanban-blockers.js';
import { topologicallySortPhaseIds, PhaseCycleError } from '../kanban-phase-topo-sort.js';
import { ensureKanbanCardForSession } from '../finalize/ensure-kanban-card.js';
import { startFinalizeRunBackground } from '../finalize/trigger-run.js';
import { markSessionFinalizeAutomation, markSessionAutoShipOnComplete } from '../session-ship.js';
import { setSessionOwner } from '../session-ownership.js';
import { finalizeTurnEndSubscriber } from '../finalize/turn-end.js';
import {
  createAutopilotBoardAdapter,
  createAutopilotFinalizeAdapter,
  createAutopilotPlannerAdapter,
  createAutopilotSessionAdapter,
  finalizeOutcomeFromSnapshot,
  type AutopilotBoardOps,
  type AutopilotFinalizeOps,
  type AutopilotPlannerOps,
  type AutopilotSessionOps,
} from './adapters.js';
import { buildAutopilotControllerDeps, type AutopilotRouteOptions } from '../routes/autopilot.js';
import { createAutopilotController } from './controller.js';
import { AutopilotStore } from './store.js';
import { createAutopilotRuntime, type AutopilotRuntime } from './runtime.js';
import type { AutopilotFinalizeResult, AutopilotSessionResult } from './orchestrator.js';
import type { AutopilotRunRecord } from './types.js';

const AUTOPILOT_KEY_LABEL = 'autopilot-key:';
const AUTOPILOT_CARD_LABEL = 'autopilot-card:';

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
interface FinalizeRunLite {
  status: string;
  reviewer_verdict: 'approved' | 'changes_requested' | null;
  pr_url: string | null;
  project_id: string;
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
    '  "qualityRubricVersion": 1',
    '}',
    'Resolve scope conflicts and the storage choice concretely before returning.',
  ].join('\n');
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
      const run = new AutopilotStore(getDb()).getRun(runId);
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
  });
}

/** Build the real Finalize ops (set merge automation + start the run). */
export function buildFinalizeOps(deps: RouteDeps): AutopilotFinalizeOps {
  return {
    startMergeAutomation: async ({ projectId, sessionId }) => {
      const session = deps.stmts.getSession.get(sessionId) as SessionRow | undefined;
      if (!session) throw new Error(`Autopilot: session ${sessionId} not found for Finalize`);
      const project = deps.findProject(projectId);
      if (!project) throw new Error(`Autopilot: project ${projectId} not found for Finalize`);
      markSessionFinalizeAutomation(deps.stmts, sessionId, 'merge');
      const { card } = ensureKanbanCardForSession(
        { stmts: deps.stmts, broadcast: deps.broadcast, findAgent: deps.findAgent },
        { projectId, session, createdBy: null },
      );
      const res = await startFinalizeRunBackground(deps, {
        project: project as Project,
        card,
        session,
        triggeredByUserId: 'autopilot',
      });
      if (!res.ok || !res.runId) {
        throw new Error(`Autopilot: Finalize did not start (${res.ok ? 'no runId' : res.error})`);
      }
      return { finalizeRunId: res.runId };
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
  return null; // not yet observable as committed; re-check next tick
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
      const run = new AutopilotStore(getDb()).getRun(runId);
      const ownerUserId = run?.credentialOwnerUserId ?? null;
      const card = stmts.getKanbanCard.get(cardId) as { id: string; title: string } | undefined;
      const sessionId = randomUUID();
      // createSession(id, agentId, name, engine, model, use_worktree, ask_mode, wiki_budget)
      stmts.createSession.run(
        sessionId,
        agent.agentId,
        card?.title ?? 'Autopilot implementation',
        agent.engine,
        agent.model,
        1,
        0,
        0,
      );
      // NOTE: scoped-worker-credential spawn env is not yet consumed by the
      // shared chat path; identity is owner-scoped via setSessionOwner. Wiring
      // the worker key into buildSpawnEnv is a follow-up (see card ed2ba39c).
      setSessionOwner(sessionId, ownerUserId);
      markSessionAutoShipOnComplete(stmts, sessionId);
      markSessionFinalizeAutomation(stmts, sessionId, 'manual'); // Finalize is driven by the controller
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

/**
 * Construct the fully-wired Autopilot runtime. Board/Finalize/planner adapters
 * are backed by real Hub subsystems; the deadline-sweep interval pumps tick().
 * Only ever advances runs for projects with Autopilot enabled and the operator
 * gate on (enforced by the controller), so with the feature off it is a no-op.
 */
export function buildAutopilotRuntime(deps: AutopilotWiringDeps): AutopilotRuntime {
  const { routeDeps } = deps;
  const stmts = routeDeps.stmts;
  const plannerOps = buildPlannerOps(deps);
  const boardOps = buildBoardOps(stmts);
  const finalizeOps = buildFinalizeOps(routeDeps);
  const sessionOps = buildSessionOps(deps);
  return createAutopilotRuntime({
    db: getDb(),
    buildController: () =>
      createAutopilotController(buildAutopilotControllerDeps(deps.controllerOptions ?? {})),
    buildAdapters: (_run: AutopilotRunRecord) => ({
      planner: createAutopilotPlannerAdapter({ ops: plannerOps }),
      board: createAutopilotBoardAdapter({ ops: boardOps }),
      session: createAutopilotSessionAdapter({ ops: sessionOps }),
      finalize: createAutopilotFinalizeAdapter({ ops: finalizeOps }),
    }),
    readSessionOutcome: (sessionId) =>
      readSessionOutcome(stmts, deps.getActiveSessionIds(), sessionId),
    readFinalizeOutcome: (finalizeRunId) => readFinalizeOutcome(stmts, finalizeRunId),
  });
}
