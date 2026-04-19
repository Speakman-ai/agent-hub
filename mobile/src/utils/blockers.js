/**
 * Client-side helpers for kanban card blockers — mirror of
 * client/src/utils/blockers.js and server/kanban-blockers.ts.
 *
 * Kept as a plain copy (not a cross-package import) because mobile and web
 * ship as separate bundles.
 */

export function hasUnresolvedBlockers(card) {
  if (!card || !Array.isArray(card.blockers)) return false;
  return card.blockers.some((b) => !b.done);
}

export function isColumnBlockerSensitive(columnName) {
  if (!columnName) return true;
  const n = String(columnName).toLowerCase();
  if (n.includes('done')) return false;
  if (n.includes('backlog')) return false;
  return true;
}

export function shouldConfirmMove(card, sourceColumnId, targetColumn) {
  if (!card || !targetColumn) return false;
  if (sourceColumnId === targetColumn.id) return false;
  if (!hasUnresolvedBlockers(card)) return false;
  return isColumnBlockerSensitive(targetColumn.name);
}
