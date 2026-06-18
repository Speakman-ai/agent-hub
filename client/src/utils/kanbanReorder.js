// Pure reorder / drop-target math for the kanban board's drag-and-drop.
//
// Kept dependency-free (no React, no @dnd-kit) so it's trivially unit-testable
// and so the board component stays a thin wiring layer over it. The board feeds
// in its loaded `cards` slice (pagination means we only ever hold part of a
// long column in memory — same limitation the pre-dnd-kit code had: positions
// are renumbered over the loaded slice only).

const COLUMN_DROPPABLE_PREFIX = 'column:';

/** Stable id for a column's droppable container (empty-column / end-of-list drops). */
export function columnDroppableId(columnId) {
  return `${COLUMN_DROPPABLE_PREFIX}${columnId}`;
}

/** True when a dnd-kit `over.id` refers to a column container rather than a card. */
export function isColumnDroppableId(id) {
  return typeof id === 'string' && id.startsWith(COLUMN_DROPPABLE_PREFIX);
}

function columnIdFromDroppable(id) {
  return String(id).slice(COLUMN_DROPPABLE_PREFIX.length);
}

const byPosition = (a, b) => a.position - b.position;

/** Loaded cards for one column, position-sorted (matches board render order). */
export function sortedColumnCards(cards, columnId) {
  return cards.filter((c) => c.column_id === columnId).sort(byPosition);
}

/**
 * True when the dragged card's vertical center sits past the hovered card's
 * midpoint — i.e. the drop is on the *bottom* half and should land *after* the
 * hovered card (the old native-DnD `dropIndicator.half === 'bottom'` contract).
 * Falls back to `false` (before / top-half) when rects are unavailable.
 *
 * dnd-kit's collision detection picks *which* card you're over, but for
 * cross-column drops the active card is not part of the target SortableContext,
 * so the strategy never shifts target items to reveal a before/after slot. We
 * reconstruct that distinction here from the rects dnd-kit hands us:
 * `active.rect.current.translated` (the dragged clone) vs `over.rect`.
 */
export function isAfterMidpoint(activeRect, overRect) {
  if (!activeRect || !overRect) return false;
  const activeCenter = activeRect.top + (activeRect.height || 0) / 2;
  const overCenter = overRect.top + (overRect.height || 0) / 2;
  return activeCenter > overCenter;
}

/**
 * Resolve a dnd-kit drag end (`active` + `over`) to a concrete drop target.
 *
 * `over` may be a bare id (column droppable / card id) or the dnd-kit `over`
 * object `{ id, rect }`. `activeRect` is the dragged card's translated rect
 * (`active.rect.current.translated`). Returns
 * `{ targetColumnId, overCardId, after }` where `overCardId` is the card the
 * drop lands relative to (null = end of the column / empty space) and `after`
 * is true when the drop is on that card's bottom half (insert after it).
 * Returns null when the drop is a no-op: no `over`, dropped onto itself, or a
 * same-column drop into the column container/whitespace (preserve position
 * instead of accidentally appending to the end).
 */
export function resolveDropTarget(activeId, over, cards, activeRect) {
  const overId = over && typeof over === 'object' ? over.id : over;
  const overRect = over && typeof over === 'object' ? over.rect : null;
  if (overId == null || overId === activeId) return null;

  if (isColumnDroppableId(overId)) {
    const targetColumnId = columnIdFromDroppable(overId);
    // The column droppable covers the whole scroll area, so releasing anywhere
    // that isn't over a card (gaps, the empty space below the last card, or a
    // near-in-place cancel) resolves here. For a card being dragged WITHIN its
    // own column that's almost always accidental — appending it to the end
    // would silently relocate a card the user didn't mean to move. Treat a
    // same-column container drop as a no-op (preserve position); appending to
    // the end of one's own column is done by dropping on the last card's bottom
    // half. A cross-column container drop is a real intent (the card isn't in
    // that column yet) and still appends to the end.
    const active = cards.find((c) => c.id === activeId);
    if (active && active.column_id === targetColumnId) return null;
    return { targetColumnId, overCardId: null, after: false };
  }

  const overCard = cards.find((c) => c.id === overId);
  if (!overCard) return null;
  return {
    targetColumnId: overCard.column_id,
    overCardId: overId,
    after: isAfterMidpoint(activeRect, overRect),
  };
}

/**
 * Compute the minimal set of `{ id, columnId, position }` updates needed to move
 * `activeId` into `targetColumnId` relative to `overCardId`:
 *   - `overCardId == null` → append to the end of the column.
 *   - `after === false` → insert *before* the hovered card (top-half drop).
 *   - `after === true`  → insert *after* the hovered card (bottom-half drop).
 *
 * Works identically for same-column reorder and cross-column moves: the active
 * card is removed from the (loaded) target ordering, re-inserted at the resolved
 * slot, and both the source and target columns are renumbered densely from 0.
 * Returns only the cards whose column or position actually changed, or [] for a
 * no-op. The server's move endpoint updates one card at a time and does NOT
 * renumber siblings, so the board issues one `api.moveCard` per returned update.
 */
export function computeMoveUpdates(cards, activeId, targetColumnId, overCardId, after = false) {
  const active = cards.find((c) => c.id === activeId);
  if (!active) return [];
  // Dropping a card onto itself is always a no-op.
  if (overCardId != null && overCardId === activeId) return [];

  const sourceColumnId = active.column_id;
  // Target ordering WITHOUT the active card (it may or may not already live in
  // this column), so the insertion index is unambiguous in both cases.
  const targetWithout = sortedColumnCards(cards, targetColumnId).filter((c) => c.id !== activeId);

  let insertAt;
  if (overCardId == null) {
    insertAt = targetWithout.length;
  } else {
    const overIdx = targetWithout.findIndex((c) => c.id === overCardId);
    insertAt = overIdx === -1 ? targetWithout.length : overIdx + (after ? 1 : 0);
  }
  insertAt = Math.max(0, Math.min(insertAt, targetWithout.length));

  const newTargetOrder = [
    ...targetWithout.slice(0, insertAt),
    { ...active, column_id: targetColumnId },
    ...targetWithout.slice(insertAt),
  ];

  const updates = [];
  newTargetOrder.forEach((c, idx) => {
    if (c.id === activeId) {
      if (active.column_id !== targetColumnId || active.position !== idx) {
        updates.push({ id: activeId, columnId: targetColumnId, position: idx });
      }
      return;
    }
    if (c.position !== idx) {
      updates.push({ id: c.id, columnId: targetColumnId, position: idx });
    }
  });

  // Cross-column: cards left behind in the source column close the gap.
  if (sourceColumnId !== targetColumnId) {
    sortedColumnCards(cards, sourceColumnId)
      .filter((c) => c.id !== activeId)
      .forEach((c, idx) => {
        if (c.position !== idx) {
          updates.push({ id: c.id, columnId: sourceColumnId, position: idx });
        }
      });
  }

  return updates;
}

/** Local arrayMove (avoids pulling @dnd-kit into this dependency-free module). */
export function arrayMove(list, from, to) {
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
