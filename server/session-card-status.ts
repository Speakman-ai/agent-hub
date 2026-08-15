/**
 * Keep the kanban card linked to a session aligned with the session's archive
 * lifecycle. Closing a session completes its card; restoring the session puts
 * the card back into active work.
 *
 * The operation is deliberately best-effort. Session archive / restore is the
 * source operation and must still succeed when a legacy board is missing one
 * of the required system columns or a board broadcast fails.
 */
import { recomputeEpicState } from './epic-state.js';
import { isColumnDone, isColumnShippedLane } from './kanban-blockers.js';
import type {
  BroadcastFn,
  KanbanBoardRow,
  KanbanCardRow,
  KanbanColumnRow,
  Stmts,
} from './types.js';

export type SessionCardStatus = 'closed' | 'in-progress';
export type SessionCardStatusAction = 'move' | 'clear-orphan' | 'keep' | 'none';

export interface SessionCardStatusDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
}

export interface SessionCardStatusResult {
  action: SessionCardStatusAction;
  reason: string;
  cardId?: string;
  projectId?: string;
  columnId?: string;
}

function findTargetColumn(
  columns: readonly KanbanColumnRow[],
  status: SessionCardStatus,
): KanbanColumnRow | undefined {
  if (status === 'closed') return columns.find((column) => isColumnDone(column.name));
  return columns.find((column) => column.name.trim().toLowerCase() === 'in progress');
}

/**
 * Move the card linked to `sessionId` to Done or In Progress. Restore also
 * clears the historical `orphaned_at` marker written by older Hub versions.
 */
export function syncLinkedCardToSessionStatus(
  deps: SessionCardStatusDeps,
  sessionId: string,
  status: SessionCardStatus,
): SessionCardStatusResult {
  const { stmts, broadcast } = deps;
  const card = stmts.getKanbanCardBySession.get(sessionId) as KanbanCardRow | undefined;
  if (!card) return { action: 'none', reason: 'no-linked-card' };

  // Restoring makes the session active regardless of whether this legacy
  // board still has the required In Progress column. Clear the stale marker
  // before column resolution so a missing target cannot leave an active card
  // looking orphaned.
  let clearedOrphan = false;
  if (status === 'in-progress' && card.orphaned_at) {
    stmts.clearKanbanCardOrphaned.run(card.id);
    clearedOrphan = true;
  }

  const board = stmts.getKanbanBoardById.get(card.board_id) as KanbanBoardRow | undefined;
  const projectId = board?.project_id;
  const columns = stmts.getKanbanColumns.all(card.board_id) as KanbanColumnRow[];

  // Shipped is a terminal lane distinct from Done. Archiving must not move a
  // card backward from either terminal lane just to reach the canonical Done
  // column.
  const current = columns.find((column) => column.id === card.column_id);
  if (status === 'closed' && (isColumnDone(current?.name) || isColumnShippedLane(current?.name))) {
    return {
      action: 'keep',
      reason: 'already-closed',
      cardId: card.id,
      projectId,
      columnId: card.column_id,
    };
  }

  const target = findTargetColumn(columns, status);
  if (!target) {
    if (clearedOrphan && projectId) {
      try {
        broadcast({ type: 'kanban_update', projectId });
      } catch {
        /* best-effort */
      }
    }
    return {
      action: clearedOrphan ? 'clear-orphan' : 'keep',
      reason:
        status === 'closed'
          ? 'no-done-column'
          : clearedOrphan
            ? 'orphan-cleared:no-in-progress-column'
            : 'no-in-progress-column',
      cardId: card.id,
      projectId,
    };
  }

  if (card.column_id === target.id) {
    if (clearedOrphan && projectId) {
      try {
        broadcast({ type: 'kanban_update', projectId });
      } catch {
        /* best-effort */
      }
    }
    return {
      action: clearedOrphan ? 'clear-orphan' : 'keep',
      reason: clearedOrphan ? 'orphan-cleared' : 'already-in-target-column',
      cardId: card.id,
      projectId,
      columnId: target.id,
    };
  }

  stmts.moveKanbanCard.run(target.id, 0, card.id);
  try {
    recomputeEpicState(stmts, card.epic_id);
  } catch {
    // The card move is authoritative; a stale epic aggregate must not prevent
    // clients from receiving the card update below.
  }

  if (projectId) {
    try {
      broadcast({ type: 'kanban_update', projectId });
      broadcast({
        type: 'card_moved',
        projectId,
        cardId: card.id,
        cardTitle: card.title,
        columnName: target.name,
        assignee: card.assignee,
        prUrl: card.pr_url ?? undefined,
        sessionId,
      });
    } catch {
      /* best-effort */
    }
  }

  return {
    action: 'move',
    reason: status === 'closed' ? 'session-closed' : 'session-restored',
    cardId: card.id,
    projectId,
    columnId: target.id,
  };
}
