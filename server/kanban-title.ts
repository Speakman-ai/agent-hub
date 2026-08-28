/**
 * Case-insensitive normalization for kanban card title dedup.
 *
 * This is the single source of truth for how a title is folded before a
 * duplicate comparison. It is registered with SQLite as the `kanban_title_norm`
 * function (see db.ts) and used to build the dedup lookup param in the card
 * routes, so the expression index and the query param fold titles identically.
 *
 * Critically it uses JavaScript `toLowerCase()`, which case-folds the full
 * Unicode range (e.g. `É` → `é`). SQLite's built-in `lower()` folds ASCII only,
 * so using it here would let `Éclair` and `éclair` slip past dedup as distinct
 * titles. Keeping both sides on this one function preserves the original
 * JS-normalized, Unicode-aware contract.
 */
export function normalizeKanbanTitle(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .trim();
}
