/**
 * release-gate-evaluator.ts — pure evaluation of a RELEASE GATE's completion
 * condition. Given a gate row and a way to resolve session/epic completion,
 * decides whether the gate is satisfied (ready to fire), pending, or blocked.
 *
 * Completion rules (locked):
 *   - session → complete when its linked kanban card sits in a Done column (the
 *     canonical "PR merged to main" signal, via {@link gatherSessionStateSignals}).
 *   - epic    → complete when every non-cancelled card is Done
 *     ({@link computeEpicState} === 'done').
 *   - The gate is satisfied only when EVERY selected session and epic is
 *     complete. A selected id that no longer exists is `missing` → the gate is
 *     `blocked` and never satisfied ("default to block"), until the operator
 *     removes it.
 *
 * Kept free of DB imports at the call boundary: the ticker/route injects
 * resolvers built by {@link buildReleaseGateResolvers}, so unit tests exercise
 * the decision logic without a database.
 */
import type { KanbanCardRow, KanbanColumnRow, KanbanEpicRow, Stmts } from '../types.js';
import { gatherSessionStateSignals } from '../session-state.js';
import { computeEpicState } from '../epic-state.js';
import { parseGateEpicIds, parseGateSessionIds } from './deployment-release-gate-store.js';
import type { DeploymentEnvironmentReleaseGateRow } from '../types.js';

export type SelectionState = 'complete' | 'pending' | 'missing';

export interface ReleaseGateSelectionStatus {
  id: string;
  state: SelectionState;
}

export interface ReleaseGateEvaluation {
  sessions: ReleaseGateSelectionStatus[];
  epics: ReleaseGateSelectionStatus[];
  sessionsComplete: number;
  sessionsTotal: number;
  epicsComplete: number;
  epicsTotal: number;
  /** Any selected session/epic no longer exists → never satisfied. */
  blocked: boolean;
  /** Every selected session and epic is complete → ready to fire. */
  satisfied: boolean;
}

export interface ReleaseGateResolvers {
  sessionState: (sessionId: string) => SelectionState;
  epicState: (epicId: string) => SelectionState;
}

/**
 * Build the DB-backed completion resolvers for a project's sessions and epics.
 * `missing` (the id no longer exists) is distinguished from `pending` so the
 * evaluator can block a gate whose selection was deleted.
 */
export function buildReleaseGateResolvers(stmts: Stmts): ReleaseGateResolvers {
  return {
    sessionState: (sessionId: string): SelectionState => {
      const session = stmts.getSession.get(sessionId) as { id?: string } | undefined;
      if (!session) return 'missing';
      return gatherSessionStateSignals(stmts, sessionId).merged ? 'complete' : 'pending';
    },
    epicState: (epicId: string): SelectionState => {
      const epic = stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined;
      if (!epic) return 'missing';
      const cards = stmts.getKanbanCardsByEpic.all(epicId) as KanbanCardRow[];
      const columns = stmts.getKanbanColumns.all(epic.board_id) as KanbanColumnRow[];
      return computeEpicState(cards, columns) === 'done' ? 'complete' : 'pending';
    },
  };
}

/** Evaluate a gate's completion condition against the given resolvers. Pure. */
export function evaluateReleaseGate(
  gate: DeploymentEnvironmentReleaseGateRow,
  resolvers: ReleaseGateResolvers,
): ReleaseGateEvaluation {
  const sessions: ReleaseGateSelectionStatus[] = parseGateSessionIds(gate).map((id) => ({
    id,
    state: resolvers.sessionState(id),
  }));
  const epics: ReleaseGateSelectionStatus[] = parseGateEpicIds(gate).map((id) => ({
    id,
    state: resolvers.epicState(id),
  }));

  const sessionsComplete = sessions.filter((s) => s.state === 'complete').length;
  const epicsComplete = epics.filter((e) => e.state === 'complete').length;
  const blocked =
    sessions.some((s) => s.state === 'missing') || epics.some((e) => e.state === 'missing');
  const total = sessions.length + epics.length;
  const allComplete = sessionsComplete === sessions.length && epicsComplete === epics.length;

  return {
    sessions,
    epics,
    sessionsComplete,
    sessionsTotal: sessions.length,
    epicsComplete,
    epicsTotal: epics.length,
    blocked,
    // A gate always watches ≥1 selection (store guard), but guard total>0 so an
    // empty gate can never "satisfy" by vacuous truth.
    satisfied: total > 0 && !blocked && allComplete,
  };
}
