import { randomUUID } from 'crypto';
import { pickDoneColumn } from './card-auto-close.js';
import { recomputeEpicState } from './epic-state.js';
import { isColumnDone, isColumnShippedLane } from './kanban-blockers.js';
import type { BroadcastFn, KanbanCardRow, KanbanColumnRow, Stmts } from './types.js';

/**
 * Close the cards a `[Resolve PR #N]` session filed for PR N once N merges.
 *
 * A Resolve PR session works on an existing PR, but its agent usually files a
 * card of its own (titled after the session). The merge only moves the card
 * the PR is linked to, so the Resolve card stayed In Progress forever. Cards
 * already in a Done or Shipped lane are left where they are.
 */
export function closeResolvePrCardsOnMerge(
  deps: {
    stmts: Stmts;
    broadcast: BroadcastFn;
  },
  args: {
    projectId: string;
    boardId: string;
    columns: KanbanColumnRow[];
    prNumber: number;
    excludeCardId?: string | null;
  },
): string[] {
  const { stmts, broadcast } = deps;
  const { projectId, boardId, columns, prNumber, excludeCardId } = args;
  const done = pickDoneColumn(columns);
  if (!done) return [];
  const prefix = `[Resolve PR #${prNumber}]%`;
  const candidates = stmts.listResolvePrCards.all(boardId, prefix, prefix) as KanbanCardRow[];
  const moved: string[] = [];
  for (const card of candidates) {
    if (card.id === excludeCardId) continue;
    const current = columns.find((c) => c.id === card.column_id);
    if (isColumnDone(current?.name) || isColumnShippedLane(current?.name)) continue;
    stmts.moveKanbanCard.run(done.id, 0, card.id);
    stmts.createKanbanCardComment.run(
      randomUUID(),
      card.id,
      'agenthub',
      `Closed with the merge of PR #${prNumber}, which this Resolve PR card was working on.`,
    );
    try {
      recomputeEpicState(stmts, card.epic_id);
    } catch {
      /* the move is authoritative; a stale epic aggregate is recomputed later */
    }
    broadcast({
      type: 'card_moved',
      // One id per move: lets subscribers tell a repeat broadcast from a new move.
      moveId: randomUUID(),
      projectId,
      cardId: card.id,
      cardTitle: card.title,
      columnName: done.name,
      assignee: card.assignee,
      prUrl: card.pr_url ?? undefined,
      sessionId: card.session_id || undefined,
    });
    moved.push(card.id);
  }
  if (moved.length > 0) broadcast({ type: 'kanban_update', projectId });
  return moved;
}
