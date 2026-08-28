import { cardMatchesEpicFilter } from './epics';
import { cardMatchesLabelFilter } from './kanbanLabels';
import { cardMatchesUserFilter } from './kanbanUserFilter';

export interface BoardCardFilters {
  searchQuery?: string;
  selectedEpicIds?: Set<string>;
  selectedLabels?: Set<string>;
  selectedUserIds?: Set<string>;
}

const EMPTY_SET: Set<string> = new Set();

/** Free-text match over the fields the board search box covers. */
export function cardMatchesSearch(card: any, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return (
    String(card.title || '')
      .toLowerCase()
      .includes(normalizedQuery) ||
    String(card.description || '')
      .toLowerCase()
      .includes(normalizedQuery) ||
    String(card.labels || '')
      .toLowerCase()
      .includes(normalizedQuery) ||
    String(card.assignee || '')
      .toLowerCase()
      .includes(normalizedQuery)
  );
}

/**
 * Group the board's cards into their columns in a SINGLE pass, applying every
 * active filter and sorting each column by position.
 *
 * The board render used to call a per-column `cardsForColumn` helper that
 * re-filtered and re-sorted the entire `cards` array once per column (plus again
 * for the selection order) — O(columns × cards) filter passes on every render,
 * the dominant re-render cost on large boards. Memoizing one call to this
 * function collapses that to a single O(cards) pass per change.
 */
export function selectVisibleCardsByColumn(
  cards: any[],
  columns: Array<{ id: string }>,
  filters: BoardCardFilters = {},
): Map<string, any[]> {
  const q = String(filters.searchQuery || '')
    .toLowerCase()
    .trim();
  const byColumn = new Map<string, any[]>();
  for (const col of columns) byColumn.set(col.id, []);

  for (const card of cards) {
    const bucket = byColumn.get(card.column_id);
    if (!bucket) continue; // card belongs to a column not being rendered
    if (!cardMatchesEpicFilter(card, filters.selectedEpicIds ?? EMPTY_SET)) continue;
    if (!cardMatchesLabelFilter(card, filters.selectedLabels ?? EMPTY_SET)) continue;
    if (!cardMatchesUserFilter(card, filters.selectedUserIds ?? EMPTY_SET)) continue;
    if (!cardMatchesSearch(card, q)) continue;
    bucket.push(card);
  }

  for (const bucket of byColumn.values()) {
    bucket.sort((a: any, b: any) => a.position - b.position);
  }
  return byColumn;
}
