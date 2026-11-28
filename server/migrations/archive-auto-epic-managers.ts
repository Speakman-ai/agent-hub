/**
 * One-shot cleanup of the `Epic: <name>` manager sessions the server used to
 * create on its own for every autonomous epic or running phase.
 *
 * A manager nobody has written to is archived, and its epic stops: the epic's
 * `autonomous` flag and every phase's `autonomous_running` go to 0 and the
 * manager link is cleared, so the person relaunches it deliberately. A manager
 * with at least one human message is kept as it is.
 *
 * Human messages are `user` rows that are not server wake-ups. Wake-ups are
 * persisted as `user` rows too, so they are recognised by the headers
 * `EpicManager` writes them with.
 *
 * A marker file in the data dir makes it run once; the selection is also
 * idempotent on its own (archived sessions are never selected again).
 */
import type BetterSqlite3 from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { stopEpicDispatchRows } from '../epic-dispatch-stop.js';

export const ARCHIVE_AUTO_EPIC_MANAGERS_MARKER = '.archive-auto-epic-managers-v1.done';

/** Headers of the brief and wake-up messages the server sends a manager. */
const SERVER_WAKE_PREFIXES = ['# Epic brief:', '## Epic manager wake-up:'];

export interface ArchiveAutoEpicManagersResult {
  ran: boolean;
  /** Manager sessions archived. */
  archived: number;
  /** Epics whose dispatch was turned off. */
  epicsStopped: number;
  /** Managers kept because a person had written to them. */
  kept: number;
  markerPath: string;
}

function isServerWake(content: string): boolean {
  const text = content.trimStart();
  return SERVER_WAKE_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export function archiveAutoEpicManagers(opts: {
  db: BetterSqlite3.Database;
  dataDir: string;
  nowIso?: () => string;
}): ArchiveAutoEpicManagersResult {
  const markerPath = path.join(opts.dataDir, ARCHIVE_AUTO_EPIC_MANAGERS_MARKER);
  if (existsSync(markerPath)) {
    return { ran: false, archived: 0, epicsStopped: 0, kept: 0, markerPath };
  }
  const { db } = opts;

  const apply = db.transaction(() => {
    const managers = db
      .prepare(
        `SELECT e.id AS epic_id, s.id AS session_id
           FROM kanban_epics e
           JOIN sessions s ON s.id = e.manager_session_id
          WHERE s.deleted_at IS NULL
            AND s.name LIKE 'Epic: %'`,
      )
      .all() as Array<{ epic_id: string; session_id: string }>;
    const userMessages = db.prepare(
      "SELECT content FROM messages WHERE session_id = ? AND role = 'user'",
    );
    const archiveSession = db.prepare(
      "UPDATE sessions SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
    );

    let archived = 0;
    let kept = 0;
    const stopped = new Set<string>();
    for (const { epic_id, session_id } of managers) {
      const rows = userMessages.all(session_id) as Array<{ content: string }>;
      if (rows.some((row) => !isServerWake(row.content ?? ''))) {
        kept++;
        continue;
      }
      archived += archiveSession.run(session_id).changes;
      stopEpicDispatchRows(db, epic_id, { clearManager: true });
      stopped.add(epic_id);
    }
    return { archived, kept, epicsStopped: stopped.size };
  });
  const result = apply();

  mkdirSync(opts.dataDir, { recursive: true });
  const stamp = opts.nowIso ? opts.nowIso() : new Date().toISOString();
  writeFileSync(markerPath, `${stamp}\n`, 'utf-8');

  return { ran: true, ...result, markerPath };
}
