/**
 * One-shot repair of kanban card ↔ session links.
 *
 * 1. Doubled `session_id` values. The bundled API wrappers used to send
 *    `X-Agent-Hub-Session-Id` twice; Node joins repeated headers with ", ", so
 *    cards were created with `session_id = "<id>, <id>"`. Lookups match the
 *    column exactly, so those cards never followed their session (archive,
 *    restore, Finalize). Collapse each list to one id: identical copies to that
 *    id, conflicting ids to the first one that still names a session.
 *
 * 2. In Progress cards whose session row is gone. Hard purge used to delete
 *    archived sessions without touching the card, leaving it In Progress on a
 *    session that no longer exists. A card whose linked native PR merged goes
 *    to Done; anything else goes back to To Do, since nobody is working on it.
 *    Each moved card gets a comment saying why.
 *
 * Guard: a marker file in the data dir makes this run once. The runtime paths
 * that produced both states are fixed, so there is nothing to re-repair.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { isColumnDone } from '../kanban-blockers.js';
import { collapseSessionIdList } from '../session-id-list.js';
import { parseNativePrUrl } from '../native-pr/url.js';
import { computeEpicStateForPersist } from '../epic-state.js';
import type { KanbanCardRow, KanbanColumnRow } from '../types.js';

export const CARD_SESSION_LINK_REPAIR_MARKER = '.card-session-link-repair-v1.done';

export interface RepairCardSessionLinksResult {
  ran: boolean;
  /** Cards whose doubled/listed `session_id` was collapsed to one id. */
  collapsed: number;
  /** In Progress cards on a missing session moved to Done (merged PR). */
  movedToDone: number;
  /** In Progress cards on a missing session moved back to To Do. */
  movedToTodo: number;
  markerPath: string;
}

interface CardLinkRow {
  id: string;
  board_id: string;
  column_id: string;
  session_id: string;
  pr_url: string | null;
  epic_id: string | null;
}

export function repairCardSessionLinks(opts: {
  db: BetterSqlite3.Database;
  dataDir: string;
}): RepairCardSessionLinksResult {
  const markerPath = path.join(opts.dataDir, CARD_SESSION_LINK_REPAIR_MARKER);
  const empty = { collapsed: 0, movedToDone: 0, movedToTodo: 0, markerPath };
  if (existsSync(markerPath)) return { ran: false, ...empty };

  const { db } = opts;
  const sessionExists = db.prepare('SELECT 1 FROM sessions WHERE id = ?');
  const setSession = db.prepare(
    "UPDATE kanban_cards SET session_id = ?, updated_at = datetime('now') WHERE id = ?",
  );
  const columnsForBoard = db.prepare('SELECT id, name FROM kanban_columns WHERE board_id = ?');
  const moveCard = db.prepare(
    "UPDATE kanban_cards SET column_id = ?, position = 0, updated_at = datetime('now') WHERE id = ?",
  );
  const addComment = db.prepare(
    'INSERT INTO kanban_card_comments (id, card_id, author, content) VALUES (?, ?, ?, ?)',
  );
  const cardsForEpic = db.prepare('SELECT column_id FROM kanban_cards WHERE epic_id = ?');
  const epicRow = db.prepare('SELECT board_id, state FROM kanban_epics WHERE id = ?');
  const setEpicState = db.prepare('UPDATE kanban_epics SET state = ? WHERE id = ?');
  const prStatus = db.prepare(
    'SELECT status FROM pull_requests WHERE project_id = ? AND number = ?',
  );

  const apply = db.transaction(() => {
    let collapsed = 0;
    let movedToDone = 0;
    let movedToTodo = 0;

    const listed = db
      .prepare("SELECT id, session_id FROM kanban_cards WHERE session_id LIKE '%,%'")
      .all() as Array<{ id: string; session_id: string }>;
    for (const card of listed) {
      const ids = (collapseSessionIdList(card.session_id) ?? '').split(', ').filter(Boolean);
      const next = ids.find((id) => sessionExists.get(id)) ?? ids[0] ?? null;
      if (next !== card.session_id) {
        setSession.run(next, card.id);
        collapsed += 1;
      }
    }

    const columnsByBoard = new Map<string, Array<{ id: string; name: string }>>();
    const touchedEpics = new Set<string>();
    const linked = db
      .prepare(
        `SELECT c.id, c.board_id, c.column_id, c.session_id, c.pr_url, c.epic_id
           FROM kanban_cards c
           JOIN kanban_columns col ON col.id = c.column_id
          WHERE c.session_id IS NOT NULL AND c.session_id != ''
            AND lower(trim(col.name)) = 'in progress'`,
      )
      .all() as CardLinkRow[];
    for (const card of linked) {
      if (sessionExists.get(card.session_id)) continue;
      let columns = columnsByBoard.get(card.board_id);
      if (!columns) {
        columns = columnsForBoard.all(card.board_id) as Array<{ id: string; name: string }>;
        columnsByBoard.set(card.board_id, columns);
      }
      const pr = parseNativePrUrl(card.pr_url);
      const merged =
        pr !== null &&
        (prStatus.get(pr.projectId, pr.number) as { status?: string } | undefined)?.status ===
          'merged';
      const target = merged
        ? columns.find((c) => isColumnDone(c.name))
        : columns.find((c) => c.name.trim().toLowerCase() === 'to do');
      if (!target || target.id === card.column_id) continue;
      moveCard.run(target.id, card.id);
      if (card.epic_id) touchedEpics.add(card.epic_id);
      addComment.run(
        randomUUID(),
        card.id,
        'agenthub',
        merged
          ? `Moved to ${target.name}: linked PR ${card.pr_url} is merged and session ${card.session_id.slice(0, 8)} no longer exists.`
          : `Moved back to ${target.name}: session ${card.session_id.slice(0, 8)} no longer exists, so nobody is working on this card.`,
      );
      if (merged) movedToDone += 1;
      else movedToTodo += 1;
    }

    // Moving a card can change its epic's derived state (e.g. its last open
    // card reached Done). The marker means this never runs again, so persist
    // the corrected state now, the same way the runtime does.
    for (const epicId of touchedEpics) {
      const epic = epicRow.get(epicId) as { board_id: string; state: string | null } | undefined;
      if (!epic) continue;
      let columns = columnsByBoard.get(epic.board_id);
      if (!columns) {
        columns = columnsForBoard.all(epic.board_id) as Array<{ id: string; name: string }>;
        columnsByBoard.set(epic.board_id, columns);
      }
      const cards = cardsForEpic.all(epicId) as Pick<KanbanCardRow, 'column_id'>[];
      const next = computeEpicStateForPersist(
        cards,
        columns as Pick<KanbanColumnRow, 'id' | 'name'>[],
      );
      if ((epic.state ?? null) !== next) setEpicState.run(next, epicId);
    }

    return { collapsed, movedToDone, movedToTodo };
  });
  const counts = apply();

  try {
    mkdirSync(opts.dataDir, { recursive: true });
    writeFileSync(markerPath, `${new Date().toISOString()}\n`, 'utf-8');
  } catch (e) {
    console.error(
      `[migration] repair-card-session-links: marker write failed (will re-run next boot): ${
        (e as Error).message
      }`,
    );
  }
  return { ran: true, ...counts, markerPath };
}
