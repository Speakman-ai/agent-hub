/**
 * What happens to an epic when its manager session goes away, and the softer
 * pause the Planning toggle uses.
 *
 * Closing (archive or delete of the manager session): the manager link is
 * cleared, epic and phase dispatch go off, and every worker on the epic with
 * a turn in flight is interrupted. Cards stay in their column with a comment;
 * worktrees and branches are not touched, so commits survive.
 *
 * Pausing: dispatch goes off so no new cards start, but the manager stays
 * linked and workers keep running.
 */
import type { Database } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { stopEpicDispatchRows } from './epic-dispatch-stop.js';
import { findProject } from './project-model.js';
import { orchestratedEpicsEnabled } from './project-orchestrated-epics.js';
import type {
  BroadcastFn,
  KanbanBoardRow,
  KanbanCardRow,
  KanbanColumnRow,
  KanbanEpicRow,
  KanbanPhaseRow,
  SessionRow,
  Stmts,
} from './types.js';

type EpicStmts = Pick<
  Stmts,
  | 'getSession'
  | 'getKanbanEpic'
  | 'getKanbanPhase'
  | 'getKanbanColumns'
  | 'getKanbanCardsByEpic'
  | 'getKanbanBoardById'
  | 'getEpicByManagerSession'
  | 'createKanbanCardComment'
>;

const WORKER_COLUMNS = new Set(['in progress', 'review']);

export type IsProjectOrchestrated = (projectId: string) => boolean;

const projectRunsOrchestratedEpics: IsProjectOrchestrated = (projectId) =>
  orchestratedEpicsEnabled(findProject(projectId));

/**
 * The epic this session manages, on a project that runs orchestrated epics.
 * Elsewhere a leftover manager link is ignored, so closing the session stops
 * nothing.
 */
function managedEpic(
  stmts: EpicStmts,
  sessionId: string,
  isProjectOrchestrated: IsProjectOrchestrated,
): KanbanEpicRow | null {
  const epic = stmts.getEpicByManagerSession.get(sessionId) as KanbanEpicRow | undefined;
  if (!epic) return null;
  const board = stmts.getKanbanBoardById.get(epic.board_id) as KanbanBoardRow | undefined;
  return board?.project_id && isProjectOrchestrated(board.project_id) ? epic : null;
}

export interface EpicWorker {
  session: SessionRow;
  card: KanbanCardRow;
}

/** Live sessions linked to the epic's In Progress / Review cards, manager excluded. */
export function listEpicWorkers(
  stmts: Pick<EpicStmts, 'getSession' | 'getKanbanColumns' | 'getKanbanCardsByEpic'>,
  epic: Pick<KanbanEpicRow, 'id' | 'board_id' | 'manager_session_id'>,
): EpicWorker[] {
  const columns = stmts.getKanbanColumns.all(epic.board_id) as KanbanColumnRow[];
  const active = new Set(
    columns.filter((c) => WORKER_COLUMNS.has(c.name.trim().toLowerCase())).map((c) => c.id),
  );
  const out: EpicWorker[] = [];
  for (const card of stmts.getKanbanCardsByEpic.all(epic.id) as KanbanCardRow[]) {
    if (!active.has(card.column_id) || !card.session_id) continue;
    const session = stmts.getSession.get(card.session_id) as SessionRow | undefined;
    if (session && !session.deleted_at && session.id !== epic.manager_session_id) {
      out.push({ session, card });
    }
  }
  return out;
}

export interface EpicCloseImpactWorker {
  sessionId: string;
  sessionName: string;
  cardId: string;
  cardTitle: string;
}

export interface EpicCloseImpact {
  epic: { id: string; name: string } | null;
  /** Workers with a turn in flight: the ones closing the session stops. */
  runningWorkers: EpicCloseImpactWorker[];
}

/** What archiving `sessionId` would stop, without changing anything. */
export function epicCloseImpact(
  stmts: EpicStmts,
  sessionId: string,
  isSessionRunning: (sessionId: string) => boolean,
  isProjectOrchestrated: IsProjectOrchestrated = projectRunsOrchestratedEpics,
): EpicCloseImpact {
  const epic = managedEpic(stmts, sessionId, isProjectOrchestrated);
  if (!epic) return { epic: null, runningWorkers: [] };
  const runningWorkers = listEpicWorkers(stmts, epic)
    .filter((w) => isSessionRunning(w.session.id))
    .map((w) => ({
      sessionId: w.session.id,
      sessionName: w.session.name ?? '',
      cardId: w.card.id,
      cardTitle: w.card.title,
    }));
  return { epic: { id: epic.id, name: epic.name }, runningWorkers };
}

export interface EpicDispatchControlDeps {
  stmts: EpicStmts;
  db: Database;
  broadcast: BroadcastFn;
  /** Stop the in-memory dispatch cron for an epic whose row is now off. */
  rescheduleEpic: (projectId: string, epic: KanbanEpicRow) => void;
  /** Stop the in-memory dispatch cron for a phase whose row is now off. */
  reschedulePhase: (projectId: string, phase: KanbanPhaseRow) => void;
  /** Lapse offers, drop queued wakes and cancel the manager's Auto start countdowns. */
  pauseManager?: (epicId: string) => void;
}

export interface EpicSessionCloseDeps extends EpicDispatchControlDeps {
  isSessionRunning: (sessionId: string) => boolean;
  /** Stop the session's in-flight turn (same path as the Stop button). */
  interruptSession: (sessionId: string) => void;
  /** Defaults to the project's `orchestratedEpics` setting. */
  isProjectOrchestrated?: IsProjectOrchestrated;
}

function stopDispatch(
  deps: EpicDispatchControlDeps,
  epic: KanbanEpicRow,
  clearManager: boolean,
): string | null {
  // Before the rows change: pausing finds the manager through its link.
  try {
    deps.pauseManager?.(epic.id);
  } catch (err) {
    console.warn(`[epic-close] manager pause failed (${epic.id}):`, (err as Error).message);
  }
  const { stoppedPhaseIds } = deps.db.transaction(() =>
    stopEpicDispatchRows(deps.db, epic.id, { clearManager }),
  )();
  const board = deps.stmts.getKanbanBoardById.get(epic.board_id) as KanbanBoardRow | undefined;
  const projectId = board?.project_id ?? null;
  if (projectId) {
    try {
      deps.rescheduleEpic(projectId, deps.stmts.getKanbanEpic.get(epic.id) as KanbanEpicRow);
      for (const phaseId of stoppedPhaseIds) {
        const phase = deps.stmts.getKanbanPhase.get(phaseId) as KanbanPhaseRow | undefined;
        if (phase) deps.reschedulePhase(projectId, phase);
      }
    } catch (err) {
      console.warn(`[epic-close] dispatch cron stop failed (${epic.id}):`, (err as Error).message);
    }
  }
  return projectId;
}

/**
 * Pause an epic: no new cards start, the manager stays linked and running
 * workers are left alone. Returns false when the epic does not exist.
 */
export function pauseEpicDispatch(deps: EpicDispatchControlDeps, epicId: string): boolean {
  const epic = deps.stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined;
  if (!epic) return false;
  const projectId = stopDispatch(deps, epic, false);
  if (projectId) deps.broadcast({ type: 'kanban_update', projectId });
  return true;
}

export interface EpicSessionCloseResult {
  epicId: string;
  /** Worker sessions whose turn was interrupted. */
  interruptedSessionIds: string[];
}

/**
 * The session is being archived or deleted. When it manages an epic, stop the
 * epic and its running workers. Returns null for any other session.
 */
export function closeEpicManagedBySession(
  deps: EpicSessionCloseDeps,
  sessionId: string,
): EpicSessionCloseResult | null {
  const epic = managedEpic(
    deps.stmts,
    sessionId,
    deps.isProjectOrchestrated ?? projectRunsOrchestratedEpics,
  );
  if (!epic) return null;
  const workers = listEpicWorkers(deps.stmts, epic);
  const projectId = stopDispatch(deps, epic, true);

  const interruptedSessionIds: string[] = [];
  for (const { session, card } of workers) {
    if (!deps.isSessionRunning(session.id)) continue;
    try {
      deps.interruptSession(session.id);
      interruptedSessionIds.push(session.id);
    } catch (err) {
      console.warn(`[epic-close] interrupt failed (${session.id}):`, (err as Error).message);
      continue;
    }
    try {
      deps.stmts.createKanbanCardComment.run(
        uuidv4(),
        card.id,
        'system',
        `⏹️ **Epic session closed**\n\nThe session managing **${epic.name}** was archived, so this card's worker was stopped mid-turn. The card stays where it is and its branch and commits are untouched. Reopen the worker session or start a new epic session to continue.`,
      );
    } catch (err) {
      console.warn(`[epic-close] card comment failed (${card.id}):`, (err as Error).message);
    }
  }
  if (projectId) deps.broadcast({ type: 'kanban_update', projectId });
  console.log(
    `[epic-close] Epic "${epic.name}" stopped: manager session ${sessionId} closed, ${interruptedSessionIds.length} worker(s) interrupted`,
  );
  return { epicId: epic.id, interruptedSessionIds };
}
