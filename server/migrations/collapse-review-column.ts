/**
 * collapse-review-column.ts — one-shot, idempotent data migration that
 * retires the legacy default **Review** kanban column.
 *
 * Why: the Review lane no longer carries product meaning — code is finalized
 * from the session (Finalize Code Changes) rather than parked for review on
 * the board, and PR review is driven by GitHub webhooks, not a column move.
 * New boards no longer seed Review (see `getOrCreateBoard` in
 * `routes/board.ts`), but there is **no in-UI column editor yet**, so existing
 * boards cannot drop the column manually. This migration does it for them.
 *
 * Behaviour, per board that still has a column literally named `'Review'`:
 *   1. Move every card in Review → that board's `'In Progress'` column,
 *      appended after any cards already there (relative order preserved).
 *   2. Delete the now-empty Review column.
 *   3. Re-pack the board's remaining column positions to 0..n-1 so the
 *      retired lane doesn't leave a gap (migrated boards then match the
 *      To Do / In Progress / Done positions of freshly-seeded ones).
 *
 * Safety:
 *   - `kanban_cards.column_id` is `ON DELETE CASCADE`, so cards MUST be moved
 *     out before the column is deleted — done in that order inside a single
 *     transaction.
 *   - A board with a Review column but **no** `'In Progress'` target is left
 *     untouched when Review still holds cards (deleting would cascade-orphan
 *     them); an *empty* Review column is dropped regardless.
 *   - Idempotent: once a board has no `'Review'` column the migration is a
 *     no-op, so it is safe to run on every boot.
 *
 * `card.updated_at` is deliberately NOT bumped — a migration shouldn't make
 * every moved card look freshly touched in activity feeds / sorting.
 */
import type Database from 'better-sqlite3';

export interface CollapseReviewResult {
  /** Boards that had a `'Review'` column when the migration ran. */
  boardsScanned: number;
  /** Cards relocated from Review → In Progress. */
  cardsMoved: number;
  /** Review columns deleted. */
  columnsDeleted: number;
  /** Boards left untouched: Review held cards but no In Progress target. */
  boardsSkipped: number;
}

export function collapseReviewColumn(db: Database.Database): CollapseReviewResult {
  const result: CollapseReviewResult = {
    boardsScanned: 0,
    cardsMoved: 0,
    columnsDeleted: 0,
    boardsSkipped: 0,
  };

  const reviewCols = db
    .prepare("SELECT id, board_id FROM kanban_columns WHERE name = 'Review'")
    .all() as Array<{ id: string; board_id: string }>;
  if (reviewCols.length === 0) return result;

  const getInProgress = db.prepare(
    "SELECT id FROM kanban_columns WHERE board_id = ? AND name = 'In Progress' ORDER BY position ASC LIMIT 1",
  );
  const getMaxPos = db.prepare(
    'SELECT COALESCE(MAX(position), -1) AS maxPos FROM kanban_cards WHERE column_id = ?',
  );
  const getCardsInColumn = db.prepare(
    'SELECT id FROM kanban_cards WHERE column_id = ? ORDER BY position ASC, created_at ASC',
  );
  const countCards = db.prepare('SELECT COUNT(*) AS n FROM kanban_cards WHERE column_id = ?');
  const moveCard = db.prepare('UPDATE kanban_cards SET column_id = ?, position = ? WHERE id = ?');
  const deleteColumn = db.prepare('DELETE FROM kanban_columns WHERE id = ?');
  const getBoardColumns = db.prepare(
    'SELECT id FROM kanban_columns WHERE board_id = ? ORDER BY position ASC, created_at ASC',
  );
  const setColumnPos = db.prepare('UPDATE kanban_columns SET position = ? WHERE id = ?');

  const repack = (boardId: string): void => {
    const cols = getBoardColumns.all(boardId) as Array<{ id: string }>;
    cols.forEach((col, idx) => setColumnPos.run(idx, col.id));
  };

  const run = db.transaction(() => {
    for (const rc of reviewCols) {
      result.boardsScanned += 1;
      const inProg = getInProgress.get(rc.board_id) as { id: string } | undefined;
      const cardCount = (countCards.get(rc.id) as { n: number }).n;

      if (!inProg) {
        // No In Progress target. Only safe to drop an empty Review column;
        // otherwise leave it so cards aren't cascade-deleted.
        if (cardCount === 0) {
          deleteColumn.run(rc.id);
          result.columnsDeleted += 1;
          repack(rc.board_id);
        } else {
          result.boardsSkipped += 1;
        }
        continue;
      }

      let pos = (getMaxPos.get(inProg.id) as { maxPos: number }).maxPos;
      const cards = getCardsInColumn.all(rc.id) as Array<{ id: string }>;
      for (const card of cards) {
        pos += 1;
        moveCard.run(inProg.id, pos, card.id);
        result.cardsMoved += 1;
      }
      deleteColumn.run(rc.id);
      result.columnsDeleted += 1;
      repack(rc.board_id);
    }
  });

  run();
  return result;
}
