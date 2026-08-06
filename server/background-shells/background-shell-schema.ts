/**
 * Schema for Hub-managed background shells — long-running shell commands
 * that outlive the chat turn that launched them.
 *
 * Distinct from the older `background_tasks` table (async agent prompt
 * turns, see `db.ts`); this owns actual OS shell processes.
 *
 * Applied both from `db.ts` at startup and from the `BackgroundShellRuntime`
 * constructor (so tests can pass a hand-built DB), so it must be idempotent.
 */
export const BACKGROUND_SHELLS_SCHEMA = `
CREATE TABLE IF NOT EXISTS background_shells (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  command TEXT NOT NULL,
  label TEXT,
  cwd TEXT,
  pid INTEGER,
  pid_start_time TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  exit_code INTEGER,
  log_path TEXT,
  watch INTEGER NOT NULL DEFAULT 0,
  watch_resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_background_shells_session ON background_shells(session_id);
CREATE INDEX IF NOT EXISTS idx_background_shells_status ON background_shells(status);
`;
