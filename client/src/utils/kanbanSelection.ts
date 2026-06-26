/**
 * Pure helpers for kanban board multi-select (web).
 */

export type KanbanSelectionToggleOpts = {
  shiftKey?: boolean;
  /** Last individually toggled card — anchor for shift-range select. */
  anchorId?: string | null;
  /** Visible cards in board order (columns left→right, cards top→bottom). */
  orderedVisibleIds?: readonly string[];
};

export type KanbanSelectionToggleResult = {
  selected: Set<string>;
  anchorId: string;
};

/** Toggle one card; shift+click selects the inclusive range from anchor. */
export function toggleKanbanCardSelection(
  selected: ReadonlySet<string>,
  cardId: string,
  opts: KanbanSelectionToggleOpts = {},
): KanbanSelectionToggleResult {
  const next = new Set(selected);
  const { shiftKey, anchorId, orderedVisibleIds } = opts;

  if (shiftKey && anchorId && orderedVisibleIds?.length) {
    const a = orderedVisibleIds.indexOf(anchorId);
    const b = orderedVisibleIds.indexOf(cardId);
    if (a >= 0 && b >= 0) {
      const [start, end] = a < b ? [a, b] : [b, a];
      for (let i = start; i <= end; i++) next.add(orderedVisibleIds[i]!);
      return { selected: next, anchorId: cardId };
    }
  }

  if (next.has(cardId)) next.delete(cardId);
  else next.add(cardId);
  return { selected: next, anchorId: cardId };
}

/** Select or deselect every id in `columnCardIds`. */
export function setKanbanColumnSelection(
  selected: ReadonlySet<string>,
  columnCardIds: readonly string[],
  select: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const id of columnCardIds) {
    if (select) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** Drop ids that no longer exist on the board. */
export function pruneKanbanSelection(
  selected: ReadonlySet<string>,
  existingCardIds: ReadonlySet<string>,
): Set<string> {
  const next = new Set<string>();
  for (const id of selected) {
    if (existingCardIds.has(id)) next.add(id);
  }
  return next;
}

/** True when every visible id in the column is selected (empty column → false). */
export function isKanbanColumnFullySelected(
  selected: ReadonlySet<string>,
  columnCardIds: readonly string[],
): boolean {
  if (columnCardIds.length === 0) return false;
  return columnCardIds.every((id) => selected.has(id));
}
