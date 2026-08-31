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

/**
 * The lifecycle value persisted for an epic that computes to *no* state (no live
 * cards, where {@link computeEpicState} returns null).
 *
 * `kanban_epics.state` is *intended* to be nullable (schema: `state TEXT DEFAULT
 * NULL CHECK (state IS NULL OR state IN (...))`), but some databases carry a
 * legacy `state TEXT NOT NULL DEFAULT 'open'` column: it pre-existed the nullable
 * redefinition, so `CREATE TABLE IF NOT EXISTS` and the guarded ALTER never
 * reconciled the constraint. Persisting NULL into that legacy column throws
 * `SQLITE_CONSTRAINT_NOTNULL` — and from the boot-time backfill that crash-loops
 * startup (a single card-less epic took prod down this way).
 *
 * Coalescing the empty case to 'not_started' is valid under BOTH the legacy
 * NOT NULL column and the current nullable+CHECK schema, and the board read
 * paths (which now trust the stored value) render a card-less epic as
 * "Not started" — a sensible, non-crashing value.
 */
export const EMPTY_EPIC_PERSISTED_STATE: EpicState = 'not_started';

/**
 * {@link computeEpicState} coalesced to a value that is always safe to persist
 * into `kanban_epics.state` (never NULL). Use this at every *write* site; keep
 * `computeEpicState` (nullable) for pure in-memory classification.
 */
export function computeEpicStateForPersist(
  cards: Pick<KanbanCardRow, 'column_id'>[],
  columns: Pick<KanbanColumnRow, 'id' | 'name'>[],
): EpicState {
  return computeEpicState(cards, columns) ?? EMPTY_EPIC_PERSISTED_STATE;
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
  // Never persist NULL: the column may be a legacy NOT NULL definition (see
  // EMPTY_EPIC_PERSISTED_STATE). Coalesce the card-less case so a runtime
  // mutation that empties an epic can't hit SQLITE_CONSTRAINT_NOTNULL.
  const state = computeEpicStateForPersist(cards, columns);
  if ((epic.state ?? null) !== state) {
    stmts.updateKanbanEpicState.run(state, epicId);
  }
  return state;
}

/**
 * Recompute persisted state for every epic on a board. Epic state is classified
 * by column *name* (done / cancelled / not-started), so a column rename, delete,
 * or reorder can change an epic's state without any card moving. The board read
 * path trusts the persisted kanban_epics.state, so column mutations must refresh
 * it here. Bounded by epic count and runs only on rare column edits — never on
 * the hot board-read path.
 */
export function recomputeEpicStatesForBoard(stmts: Stmts, boardId: string): void {
  const epics = stmts.getKanbanEpics.all(boardId) as KanbanEpicRow[];
  for (const epic of epics) {
    recomputeEpicState(stmts, epic.id);
  }
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
