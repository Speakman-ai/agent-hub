/**
 * Client-side helpers for kanban card blockers.
 *
 * The server is the source of truth for whether a blocker is "done" (it
 * annotates each blocker row with `done: true|false` via GET /board). These
 * helpers just inspect that payload to drive UX gating.
 */

/**
 * True if the card has at least one blocker that isn't yet done.
 *
 * Expects `card.blockers` to be the server-enriched array of
 * `{ id, title, column_id, done }`. Missing / empty array ⇒ false.
 */
export function hasUnresolvedBlockers(card) {
  if (!card || !Array.isArray(card.blockers)) return false;
  return card.blockers.some((b) => !b.done);
}

/**
 * Mirror of the server's `isColumnBlockerSensitive`. Any column whose name
 * contains "backlog" or "done" (case-insensitive) is NOT sensitive — moving
 * a blocked card there is fine. Any other column should prompt the user.
 *
 * Kept in sync with server/kanban-blockers.ts so a rename on either side
 * behaves identically.
 */
export function isColumnBlockerSensitive(columnName) {
  if (!columnName) return true;
  const n = String(columnName).toLowerCase();
  if (n.includes('done')) return false;
  if (n.includes('backlog')) return false;
  return true;
}

/**
 * Should we show a confirm dialog before moving `card` into `targetColumn`?
 *
 * Three things must all be true:
 *   1. The card has unresolved blockers.
 *   2. The target column is blocker-sensitive (not Backlog or Done).
 *   3. The card is actually moving columns (not reordering within the same).
 */
export function shouldConfirmMove(card, sourceColumnId, targetColumn) {
  if (!card || !targetColumn) return false;
  if (sourceColumnId === targetColumn.id) return false;
  if (!hasUnresolvedBlockers(card)) return false;
  return isColumnBlockerSensitive(targetColumn.name);
}
