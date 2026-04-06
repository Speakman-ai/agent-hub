import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'agent-hub.db');

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS heartbeat_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    prompt TEXT NOT NULL,
    result TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'success', 'error'))
  );

  CREATE TABLE IF NOT EXISTS crons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    schedule TEXT NOT NULL,
    prompt TEXT NOT NULL,
    cwd TEXT NOT NULL DEFAULT '/home/ryan',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run TEXT,
    last_result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

  CREATE TABLE IF NOT EXISTS active_tasks (
    session_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    pid INTEGER,
    prompt TEXT NOT NULL,
    streamed_output TEXT NOT NULL DEFAULT '',
    engine TEXT NOT NULL,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','error','cancelled')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS slack_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_ts TEXT,
    user_id TEXT NOT NULL,
    user_message TEXT NOT NULL,
    bot_response TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_heartbeat_agent ON heartbeat_logs(agent_id);
  CREATE INDEX IF NOT EXISTS idx_heartbeat_timestamp ON heartbeat_logs(timestamp);
  CREATE INDEX IF NOT EXISTS idx_slack_agent ON slack_messages(agent_id);
  CREATE INDEX IF NOT EXISTS idx_slack_timestamp ON slack_messages(timestamp);

  -- Persistent next-run tracking so heartbeats survive server restarts.
  -- Agents themselves live in agents.json, so this table is keyed by agent id.
  CREATE TABLE IF NOT EXISTS heartbeat_state (
    agent_id TEXT PRIMARY KEY,
    next_run_at TEXT,
    last_run_at TEXT
  );

  -- Session events: structured event stream from Claude Code / Cursor Agent
  -- stream-json output. One row per event (system init, tool_use, tool_result,
  -- assistant_text, thinking, result, etc.). Used by the UI to render the
  -- full thread of a chat / heartbeat / cron run instead of just the summary.
  CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_kind TEXT NOT NULL CHECK(parent_kind IN ('message','heartbeat','cron')),
    parent_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_session_events_parent
    ON session_events(parent_kind, parent_id, seq);
`);

// Migration: add next_run_at to crons (last_run already exists)
try {
  db.prepare('SELECT next_run_at FROM crons LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE crons ADD COLUMN next_run_at TEXT');
}

// Migrations: add engine columns if missing
try {
  db.prepare("SELECT engine FROM sessions LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE sessions ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude-code'");
}
try {
  db.prepare("SELECT engine FROM messages LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE messages ADD COLUMN engine TEXT");
}
try {
  db.prepare("SELECT model FROM sessions LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE sessions ADD COLUMN model TEXT NOT NULL DEFAULT 'claude-opus-4-6'");
}
try {
  db.prepare("SELECT model FROM messages LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE messages ADD COLUMN model TEXT");
}
try {
  db.prepare("SELECT engine_session_id FROM sessions LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE sessions ADD COLUMN engine_session_id TEXT");
}

// Seed default crons if table is empty
const cronCount = db.prepare('SELECT COUNT(*) as count FROM crons').get();
if (cronCount.count === 0) {
  const insertCron = db.prepare(
    'INSERT INTO crons (name, schedule, prompt, cwd, enabled) VALUES (?, ?, ?, ?, ?)'
  );
  insertCron.run(
    'dependabot-merger',
    '0 */6 * * *',
    'Check all repos (mcsteen/surveytracker, speakmanra/relic-book, speakmanra/homeinspector, speakmanra/pipeline-engine) for open Dependabot PRs using gh CLI. If any have passing CI, merge them with gh pr merge --squash.',
    '/home/ryan',
    1
  );
  insertCron.run(
    'job-search-monitor',
    '0 8 * * 1-5',
    'Search for senior full-stack software engineer remote jobs. Check Gmail for any job application responses. Search LinkedIn for new postings matching: Python, Django, TypeScript, React, AWS, healthcare. Summarize findings.',
    '/home/ryan',
    0
  );
}

// Prepared statements
const stmts = {
  // Sessions
  createSession: db.prepare(
    'INSERT INTO sessions (id, agent_id, name, engine, model) VALUES (?, ?, ?, ?, ?)'
  ),
  getSessions: db.prepare(
    'SELECT * FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC'
  ),
  getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  updateSessionName: db.prepare(
    "UPDATE sessions SET name = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  touchSession: db.prepare(
    "UPDATE sessions SET updated_at = datetime('now') WHERE id = ?"
  ),

  // Sessions - engine & model
  updateSessionEngine: db.prepare(
    "UPDATE sessions SET engine = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  updateSessionModel: db.prepare(
    "UPDATE sessions SET model = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  updateSessionEngineSessionId: db.prepare(
    "UPDATE sessions SET engine_session_id = ?, updated_at = datetime('now') WHERE id = ?"
  ),

  // Active tasks
  getActiveTask: db.prepare('SELECT * FROM active_tasks WHERE session_id = ?'),
  getAllActiveTasks: db.prepare(
    "SELECT * FROM active_tasks WHERE status = 'running' ORDER BY started_at ASC"
  ),
  insertActiveTask: db.prepare(
    `INSERT INTO active_tasks
      (session_id, message_id, agent_id, pid, prompt, engine, model, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`
  ),
  updateActiveTaskPid: db.prepare(
    "UPDATE active_tasks SET pid = ?, updated_at = datetime('now') WHERE session_id = ?"
  ),
  appendActiveTaskOutput: db.prepare(
    "UPDATE active_tasks SET streamed_output = ?, updated_at = datetime('now') WHERE session_id = ?"
  ),
  deleteActiveTask: db.prepare('DELETE FROM active_tasks WHERE session_id = ?'),
  deleteAllActiveTasks: db.prepare('DELETE FROM active_tasks'),

  // Messages
  addMessage: db.prepare(
    'INSERT INTO messages (id, session_id, role, content, engine, model) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  getMessages: db.prepare(
    'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC'
  ),
  getLastMessage: db.prepare(
    'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
  ),

  // Heartbeat logs
  addHeartbeatLog: db.prepare(
    'INSERT INTO heartbeat_logs (agent_id, prompt, status) VALUES (?, ?, ?)'
  ),
  updateHeartbeatLog: db.prepare(
    'UPDATE heartbeat_logs SET result = ?, status = ? WHERE id = ?'
  ),
  getHeartbeatLogs: db.prepare(
    'SELECT * FROM heartbeat_logs WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?'
  ),
  getLatestHeartbeat: db.prepare(
    'SELECT * FROM heartbeat_logs WHERE agent_id = ? ORDER BY timestamp DESC LIMIT 1'
  ),

  // Crons
  getCrons: db.prepare('SELECT * FROM crons ORDER BY id ASC'),
  getCron: db.prepare('SELECT * FROM crons WHERE id = ?'),
  createCron: db.prepare(
    'INSERT INTO crons (name, schedule, prompt, cwd, enabled) VALUES (?, ?, ?, ?, ?)'
  ),
  updateCron: db.prepare(
    'UPDATE crons SET name = ?, schedule = ?, prompt = ?, cwd = ?, enabled = ? WHERE id = ?'
  ),
  deleteCron: db.prepare('DELETE FROM crons WHERE id = ?'),
  updateCronResult: db.prepare(
    "UPDATE crons SET last_run = datetime('now'), last_result = ? WHERE id = ?"
  ),
  updateCronNextRun: db.prepare(
    'UPDATE crons SET next_run_at = ? WHERE id = ?'
  ),

  // Session events (stream-json telemetry for chat/heartbeat/cron runs)
  addSessionEvent: db.prepare(
    `INSERT INTO session_events (parent_kind, parent_id, seq, event_type, payload)
     VALUES (?, ?, ?, ?, ?)`
  ),
  getSessionEvents: db.prepare(
    `SELECT * FROM session_events
     WHERE parent_kind = ? AND parent_id = ?
     ORDER BY seq ASC`
  ),
  deleteSessionEvents: db.prepare(
    'DELETE FROM session_events WHERE parent_kind = ? AND parent_id = ?'
  ),
  countSessionEvents: db.prepare(
    'SELECT COUNT(*) as count FROM session_events WHERE parent_kind = ? AND parent_id = ?'
  ),

  // Heartbeat next-run state (survives server restarts)
  upsertHeartbeatState: db.prepare(
    `INSERT INTO heartbeat_state (agent_id, next_run_at, last_run_at)
     VALUES (?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       next_run_at = COALESCE(excluded.next_run_at, heartbeat_state.next_run_at),
       last_run_at = COALESCE(excluded.last_run_at, heartbeat_state.last_run_at)`
  ),
  getHeartbeatState: db.prepare(
    'SELECT * FROM heartbeat_state WHERE agent_id = ?'
  ),
  deleteHeartbeatState: db.prepare(
    'DELETE FROM heartbeat_state WHERE agent_id = ?'
  ),

  // Slack messages
  addSlackMessage: db.prepare(
    'INSERT INTO slack_messages (agent_id, channel_id, thread_ts, user_id, user_message, bot_response) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  getSlackMessages: db.prepare(
    'SELECT * FROM slack_messages WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?'
  ),
  getAllSlackMessages: db.prepare(
    'SELECT * FROM slack_messages ORDER BY timestamp DESC LIMIT ?'
  ),
};

export { db, stmts };
