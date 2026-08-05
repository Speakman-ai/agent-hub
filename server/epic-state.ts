import { isColumnCancelled, isColumnDone, isColumnNotStarted } from './kanban-blockers.js';
import type { KanbanCardRow, KanbanColumnRow, KanbanEpicRow, Stmts } from './types.js';

export const EPIC_STATES = ['not_started', 'in_progress', 'done'] as const;
export type EpicState = (typeof EPIC_STATES)[number];
export type EpicLifecycleState = EpicState | null;

export function computeEpicState(
  cards: Pick<KanbanCardRow, 'column_id'>[],
  columns: Pick<KanbanColumnRow, 'id' | 'name'>[],
): EpicLifecycleState {
  const columnNameById = new Map(columns.map((column) => [column.id, column.name]));
  // Cancelled cards are dropped work; they must not drive epic state. An epic
  // whose only non-cancelled cards are all Done should read `done`, not sit
  // `in_progress` forever behind a cancelled ticket.
  const liveCards = cards.filter((card) => !isColumnCancelled(columnNameById.get(card.column_id)));
  if (liveCards.length === 0) return null;
  const allDone = liveCards.every((card) => isColumnDone(columnNameById.get(card.column_id)));
  if (allDone) return 'done';
  const anyStarted = liveCards.some((card) => {
    const columnName = columnNameById.get(card.column_id);
    return isColumnDone(columnName) || !isColumnNotStarted(columnName);
  });
  return anyStarted ? 'in_progress' : 'not_started';
}

export function recomputeEpicState(
  stmts: Stmts,
  epicId: string | null | undefined,
): EpicLifecycleState {
  if (!epicId) return null;
  const epic = stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined;
  if (!epic) return null;
  const cards = stmts.getKanbanCardsByEpic.all(epicId) as KanbanCardRow[];
  const columns = stmts.getKanbanColumns.all(epic.board_id) as KanbanColumnRow[];
  const state = computeEpicState(cards, columns);
  if ((epic.state ?? null) !== state) {
    stmts.updateKanbanEpicState.run(state, epicId);
  }
  return state;
}

export function epicsWithComputedState(
  epics: KanbanEpicRow[],
  cards: Pick<KanbanCardRow, 'epic_id' | 'column_id'>[],
  columns: Pick<KanbanColumnRow, 'id' | 'name'>[],
): KanbanEpicRow[] {
  const cardsByEpicId = new Map<string, Pick<KanbanCardRow, 'column_id'>[]>();
  for (const card of cards) {
    if (!card.epic_id) continue;
    const bucket = cardsByEpicId.get(card.epic_id) ?? [];
    bucket.push(card);
    cardsByEpicId.set(card.epic_id, bucket);
  }
  return epics.map((epic) => ({
    ...epic,
    state: computeEpicState(cardsByEpicId.get(epic.id) ?? [], columns),
  }));
}
