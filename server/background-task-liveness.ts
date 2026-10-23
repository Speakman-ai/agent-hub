import type { Stmts } from './types.js';

/**
 * How long a freshly inserted `running` background task counts as live before
 * its `active_tasks` row shows up. Dispatch inserts the background task, then
 * `handleChat` inserts `active_tasks` only after some async setup, so a
 * double-click inside that window must still see the first dispatch.
 */
export const BACKGROUND_TASK_STARTUP_GRACE_MS = 2 * 60 * 1000;

/** Parse a SQLite `datetime('now')` stamp (UTC, no zone suffix) to epoch ms. */
function parseSqliteUtc(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Whether a `background_tasks` row with `status = 'running'` is backed by a
 * turn that is actually in flight.
 *
 * The `running` status alone is not trustworthy: a Hub restart kills the CLI
 * child and clears every `active_tasks` row, but nothing flips the background
 * task to a terminal state, so it reads `running` forever. Idempotency guards
 * that trusted it reported "a session is already running" for sessions that
 * had long since died. `active_tasks` is the in-flight signal (inserted when a
 * turn spawns, deleted when it ends, wiped on restart); a task younger than
 * the startup grace window also counts so the dispatch→spawn gap stays covered.
 */
export function isBackgroundTaskLive(
  stmts: Pick<Stmts, 'getActiveTask'>,
  task: { session_id: string; created_at?: string | null },
  now: number = Date.now(),
): boolean {
  try {
    if (stmts.getActiveTask.get(task.session_id)) return true;
  } catch {
    /* fall through to the age check */
  }
  const created = parseSqliteUtc(task.created_at);
  return created !== null && now - created < BACKGROUND_TASK_STARTUP_GRACE_MS;
}
