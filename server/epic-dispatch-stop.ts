/**
 * Turn an epic's dispatch off in the database: the epic's `autonomous` flag
 * and every phase's `autonomous_running` go to 0. With `clearManager` the
 * manager link is dropped too, so a person has to start a new epic session.
 *
 * Only the rows change. Callers running inside the live server also have to
 * stop the in-memory dispatch crons (see `epic-session-close.ts`).
 */
import type { Database } from 'better-sqlite3';

export interface StopEpicDispatchResult {
  /** Phases that were running before the stop. */
  stoppedPhaseIds: string[];
}

export function stopEpicDispatchRows(
  db: Database,
  epicId: string,
  opts: { clearManager: boolean },
): StopEpicDispatchResult {
  const stoppedPhaseIds = (
    db
      .prepare('SELECT id FROM kanban_phases WHERE epic_id = ? AND autonomous_running = 1')
      .all(epicId) as Array<{ id: string }>
  ).map((row) => row.id);
  db.prepare(
    opts.clearManager
      ? "UPDATE kanban_epics SET autonomous = 0, manager_session_id = NULL, updated_at = datetime('now') WHERE id = ?"
      : "UPDATE kanban_epics SET autonomous = 0, updated_at = datetime('now') WHERE id = ?",
  ).run(epicId);
  db.prepare(
    'UPDATE kanban_phases SET autonomous_running = 0 WHERE epic_id = ? AND autonomous_running = 1',
  ).run(epicId);
  return { stoppedPhaseIds };
}
