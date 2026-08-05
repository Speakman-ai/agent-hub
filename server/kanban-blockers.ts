/**
 * Card-to-card blocker helpers.
 *
 * A blocker row in `kanban_card_blockers` means `card_id` is blocked by
 * `blocked_by_card_id`. The relationship is many-to-many and enforced to be
 * acyclic at the application layer (SQLite can't express that natively).
 *
 * The helpers in this module are shared between the board route (for
 * request-time enrichment and cycle detection on POST) and the autonomous
 * dispatcher (for skipping cards whose blockers aren't yet Done).
 */

import type { KanbanBlockerLink, Stmts } from './types.js';

// ─── Column semantics ──────────────────────────────────────────────────────

/**
 * A blocker counts as "resolved" once its card sits in a Done-ish column.
 *
 * The board's default seed uses the exact name "Done", but users can rename
 * columns freely, so we match on a case-insensitive substring. That keeps
 * "Done", "Done ✅", "Deployed / Done" etc. all resolving the blocker.
 *
 * Deliberately loose — false positives here are preferable to false negatives
 * (a blocker stuck at "unresolved" forever because someone renamed a column).
 */
export function isColumnDone(columnName: string | null | undefined): boolean {
  if (!columnName) return false;
  return columnName.toLowerCase().includes('done');
}

/**
 * Default-seed columns the automation stack keys off by name: autonomous
 * dispatch (`To Do`), assign/finalize lifecycle (`In Progress`), and
 * terminal merge/push state (`Done`). These may not be deleted or renamed.
 * Color and position changes remain allowed.
 */
export function isSystemLockedColumnName(columnName: string | null | undefined): boolean {
  if (!columnName) return false;
  const n = columnName.trim().toLowerCase();
  return n === 'to do' || n === 'in progress' || n === 'done';
}

/**
 * A "Canceled" / "Cancelled" column holds dropped work, not live tickets.
 * Matches both spellings on a word boundary so custom names like
 * "Won't do / Cancelled" still qualify without misclassifying unrelated
 * columns. Used to keep cancelled cards out of epic ticket sets and epic-state.
 */
export function isColumnCancelled(columnName: string | null | undefined): boolean {
  if (!columnName) return false;
  return /\bcancell?ed\b/i.test(columnName.trim());
}

/**
 * Backlog-style columns holding work that has not been picked up yet. Matches
 * the default seed's "To Do" plus any column whose name contains "backlog".
 * Combined with {@link isColumnDone} / {@link isColumnCancelled} this
 * classifies a card as not-started vs. in-flight vs. finished.
 */
export function isColumnNotStarted(columnName: string | null | undefined): boolean {
  if (!columnName) return false;
  const normalized = columnName.trim().toLowerCase();
  return normalized === 'to do' || normalized === 'todo' || normalized.includes('backlog');
}

/**
 * Shipped / release lanes count as closed for org headline metrics (`openCards`,
 * `openPRs`, priority breakdown). Uses a word-boundary match on `shipped` so
 * **"Unshipped"** is not misclassified (a naive `includes('shipped')` would).
 */
export function isColumnShippedLane(columnName: string | null | undefined): boolean {
  if (!columnName) return false;
  return /\bshipped\b/i.test(columnName.trim());
}

/**
 * Columns where the move-confirmation dialog should fire. Dragging a card
 * INTO Done with unresolved blockers is never suspicious (the user is
 * marking work finished; blockers are informational).
 *
 * The substring `backlog` is also treated as blocker-insensitive — but
 * with a narrow lifetime now that the default seed no longer includes
 * Backlog. The only boards that can still hit this branch are:
 *   (a) custom user columns whose name CONTAINS "backlog" but isn't the
 *       literal "Backlog" (e.g. "Project Backlog", "Team backlog") —
 *       the db.ts migration uses an exact-case `name = 'Backlog'` match
 *       and leaves substring variants alone; and
 *   (b) a column named literally "Backlog" that a user creates AFTER
 *       the most recent server boot. The next boot's migration will
 *       drop it; until then, this predicate keeps drag-into-Backlog
 *       quiet.
 *
 * Any other column (To Do, In Progress, Review, other custom columns)
 * triggers the confirm dialog when blockers are unresolved. Clients
 * mirror this predicate so no server-side 409 gating is needed.
 */
export function isColumnBlockerSensitive(columnName: string | null | undefined): boolean {
  if (!columnName) return true;
  const n = columnName.toLowerCase();
  if (n.includes('done')) return false;
  if (n.includes('backlog')) return false;
  return true;
}

// ─── Cycle detection ───────────────────────────────────────────────────────

/**
 * Walk the blocker graph upward from `candidateBlockerId`. If we can reach
 * `cardId` via any chain of `blocked_by_card_id` edges, adding
 * (cardId → candidateBlockerId) would close a cycle.
 *
 * Returns the cycle path as [cardId, ..., candidateBlockerId, cardId] when a
 * cycle is detected, or null if the edge is safe to insert. The path is
 * surfaced via the 409 response so UIs can show the user WHY a link was
 * rejected rather than a generic error.
 *
 * Worst case O(E) where E is the number of blocker edges in the transitive
 * closure — bounded by the board's total blocker rows. Boards of realistic
 * size (<1k cards, <2k edges) traverse in microseconds.
 */
export function findCycle(
  stmts: Stmts,
  cardId: string,
  candidateBlockerId: string,
): string[] | null {
  if (cardId === candidateBlockerId) {
    return [cardId, cardId];
  }
  // BFS from the candidate blocker; if we encounter `cardId`, the proposed
  // edge would close a cycle. Track `parent` so we can rebuild the path.
  const parents = new Map<string, string>();
  const visited = new Set<string>([candidateBlockerId]);
  const queue: string[] = [candidateBlockerId];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    const rows = stmts.getBlockersForCard.all(current) as Array<{ blocked_by_card_id: string }>;
    for (const row of rows) {
      const next = row.blocked_by_card_id;
      if (next === cardId) {
        // Reconstruct path: cardId → candidateBlocker → ... → current → cardId
        const path: string[] = [cardId];
        // Walk parent chain from `current` back to `candidateBlockerId`.
        const chain: string[] = [current];
        let p = current;
        while (parents.has(p)) {
          p = parents.get(p) as string;
          chain.push(p);
        }
        // `chain` is [current, ..., candidateBlockerId]. We want the path in
        // cycle order: cardId → candidateBlockerId → ... → current → cardId.
        chain.reverse();
        path.push(...chain, cardId);
        return path;
      }
      if (!visited.has(next)) {
        visited.add(next);
        parents.set(next, current);
        queue.push(next);
      }
    }
  }
  return null;
}

// ─── Enrichment for GET /board ─────────────────────────────────────────────

interface BoardBlockerRow {
  card_id: string;
  blocked_by_card_id: string;
  blocker_id: string;
  blocker_title: string;
  blocker_column_id: string;
  blocker_column_name: string;
  blocked_id: string;
  blocked_title: string;
  blocked_column_id: string;
  blocked_column_name: string;
}

export interface BoardBlockerIndex {
  /** card_id → list of cards blocking it */
  blockersByCard: Map<string, KanbanBlockerLink[]>;
  /** blocked_by_card_id → list of cards it blocks */
  blocksByCard: Map<string, KanbanBlockerLink[]>;
}

/**
 * Fetch every blocker edge for a board in a single query and index it in
 * both directions. Called once per GET /board request; the result is used
 * to annotate each card with `blockers` and `blocks`.
 *
 * Why both directions: the UI wants to show "this card is blocked by X, Y"
 * AND "this card is blocking Z, W" — the second is useful for understanding
 * ripple effects when a card lands.
 */
export function loadBoardBlockers(stmts: Stmts, boardId: string): BoardBlockerIndex {
  const rows = stmts.getBlockersForBoard.all(boardId) as BoardBlockerRow[];
  const blockersByCard = new Map<string, KanbanBlockerLink[]>();
  const blocksByCard = new Map<string, KanbanBlockerLink[]>();

  for (const r of rows) {
    // Blocker side — record against the blocked card.
    const blockerLink: KanbanBlockerLink = {
      id: r.blocker_id,
      title: r.blocker_title,
      column_id: r.blocker_column_id,
      done: isColumnDone(r.blocker_column_name),
    };
    const blockerArr = blockersByCard.get(r.card_id);
    if (blockerArr) blockerArr.push(blockerLink);
    else blockersByCard.set(r.card_id, [blockerLink]);

    // Blocks side — record against the blocking card.
    const blockedLink: KanbanBlockerLink = {
      id: r.blocked_id,
      title: r.blocked_title,
      column_id: r.blocked_column_id,
      done: isColumnDone(r.blocked_column_name),
    };
    const blocksArr = blocksByCard.get(r.blocked_by_card_id);
    if (blocksArr) blocksArr.push(blockedLink);
    else blocksByCard.set(r.blocked_by_card_id, [blockedLink]);
  }

  return { blockersByCard, blocksByCard };
}

/**
 * Does this card have any blocker that isn't yet Done? Used by the
 * autonomous dispatcher to skip cards and by the API to decide whether to
 * surface the blocked banner/badge. Safe to call with a card that has no
 * blockers — returns false.
 */
export function hasUnresolvedBlockers(cardId: string, index: BoardBlockerIndex): boolean {
  const blockers = index.blockersByCard.get(cardId);
  if (!blockers || blockers.length === 0) return false;
  return blockers.some((b) => !b.done);
}
