/**
 * backfill-epic-states.ts — one-shot recompute of every kanban epic's persisted
 * `state` from its cards and columns.
 *
 * Why: the board read paths (paginated GET /board and GET /board/epics) now trust
 * the stored `kanban_epics.state` instead of deriving it live from cards +
 * columns on every request. `recomputeEpicState` keeps that column current on
 * card mutations and on column renames going forward, but rows written before
 * that maintenance existed — or boards whose columns were renamed while reads
 * were still live-derived — can carry a stale (or NULL) `state`. Trusting the
 * stored value without a backfill would surface that stale state indefinitely,
 * until an unrelated mutation happened to recompute it.
 *
 * This migration recomputes all epic states once so the stored value is correct
 * before any read starts trusting it. The classification is column-name based,
 * so it is done in JS with the same `computeEpicState` the runtime uses — the two
 * can never diverge.
 *
 * Guard: a marker file in the data dir makes this run exactly once. Re-running is
 * harmless (the recompute is deterministic), but a boot-time full recompute is
 * O(epic cards) and pointless once the stored state is authoritative and
 * incrementally maintained.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { computeEpicStateForPersist } from '../epic-state.js';
import type { KanbanCardRow, KanbanColumnRow } from '../types.js';

/** Marker file written into the data dir once the backfill has run. */
export const EPIC_STATES_BACKFILL_MARKER = '.epic-states-backfill-v1.done';

export interface BackfillEpicStatesResult {
  /** True when the backfill ran this call; false when the marker already existed. */
  ran: boolean;
  /** Number of epics whose stored `state` was corrected. */
  updated: number;
  /** Absolute path to the marker file. */
  markerPath: string;
  /** True when the one-time marker was persisted (best-effort; false on write failure). */
  markerWritten?: boolean;
}

/**
 * Recompute every epic's persisted state once. Idempotent across calls: the
 * first call recomputes and drops the marker; later calls short-circuit on it.
 */
export function backfillEpicStates(opts: {
  db: BetterSqlite3.Database;
  dataDir: string;
  nowIso?: () => string;
}): BackfillEpicStatesResult {
  const markerPath = path.join(opts.dataDir, EPIC_STATES_BACKFILL_MARKER);
  if (existsSync(markerPath)) {
    return { ran: false, updated: 0, markerPath };
  }

  const { db } = opts;
  const epics = db.prepare('SELECT id, board_id, state FROM kanban_epics').all() as Array<{
    id: string;
    board_id: string;
    state: string | null;
  }>;
  const cardsForEpic = db.prepare('SELECT column_id FROM kanban_cards WHERE epic_id = ?');
  const columnsForBoard = db.prepare('SELECT id, name FROM kanban_columns WHERE board_id = ?');
  const updateState = db.prepare('UPDATE kanban_epics SET state = ? WHERE id = ?');

  // Cache columns per board — many epics share a board, and the classification
  // only needs (id, name).
  const columnsByBoard = new Map<string, Pick<KanbanColumnRow, 'id' | 'name'>[]>();

  const apply = db.transaction(() => {
    let updated = 0;
    for (const epic of epics) {
      let columns = columnsByBoard.get(epic.board_id);
      if (!columns) {
        columns = columnsForBoard.all(epic.board_id) as Pick<KanbanColumnRow, 'id' | 'name'>[];
        columnsByBoard.set(epic.board_id, columns);
      }
      const cards = cardsForEpic.all(epic.id) as Pick<KanbanCardRow, 'column_id'>[];
      // Coalesce the card-less (null) case: `kanban_epics.state` may be a legacy
      // NOT NULL column on older DBs, where persisting NULL throws
      // SQLITE_CONSTRAINT_NOTNULL and crash-loops boot. See EMPTY_EPIC_PERSISTED_STATE.
      const next = computeEpicStateForPersist(cards, columns);
      if ((epic.state ?? null) !== next) {
        updateState.run(next, epic.id);
        updated += 1;
      }
    }
    return updated;
  });
  // The recompute (above) is the correctness-critical step: if it throws, the
  // error propagates so the caller can refuse to start rather than serve stale
  // persisted state. The recompute is atomic (db.transaction), so a failure
  // leaves state untouched and the next boot retries.
  const updated = apply();

  // The marker is only an optimization (skip the recompute next boot). A failure
  // to persist it must NOT crash startup or discard the correct recompute — it
  // just means we recompute again next boot. Best-effort, never throws.
  let markerWritten = false;
  try {
    mkdirSync(opts.dataDir, { recursive: true });
    const stamp = opts.nowIso ? opts.nowIso() : new Date().toISOString();
    writeFileSync(markerPath, `${stamp}\n`, 'utf-8');
    markerWritten = true;
  } catch (e) {
    console.error(
      '[migration] backfill-epic-states: recompute succeeded but marker write failed ' +
        `(will re-run next boot): ${(e as Error).message}`,
    );
  }

  return { ran: true, updated, markerPath, markerWritten };
}
