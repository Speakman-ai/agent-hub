import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(config.dataDir, 'agent-hub.db');

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
    cwd TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run TEXT,
    last_result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

  -- Conference rooms: multi-agent group chats
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    max_turns INTEGER NOT NULL DEFAULT 10,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS room_agents (
    room_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (room_id, agent_id),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS room_messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    agent_id TEXT,
    agent_name TEXT,
    agent_color TEXT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room_id);
  CREATE INDEX IF NOT EXISTS idx_room_agents_room ON room_agents(room_id);

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

  CREATE TABLE IF NOT EXISTS cron_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cron_id INTEGER NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'success', 'error')),
    result TEXT,
    duration_ms INTEGER,
    FOREIGN KEY (cron_id) REFERENCES crons(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_cron_logs_cron ON cron_logs(cron_id);
  CREATE INDEX IF NOT EXISTS idx_cron_logs_timestamp ON cron_logs(timestamp);

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

  -- Delegations: tracks sub-agent tasks spawned by a lead agent
  CREATE TABLE IF NOT EXISTS delegations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_message_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    agent_name TEXT,
    task TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','error','cancelled')),
    output TEXT,
    error TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_delegations_session ON delegations(session_id);
  CREATE INDEX IF NOT EXISTS idx_delegations_parent ON delegations(parent_message_id);
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

// Migration: add worktree columns to sessions
try {
  db.prepare('SELECT use_worktree FROM sessions LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE sessions ADD COLUMN use_worktree INTEGER NOT NULL DEFAULT 1');
}
try {
  db.prepare('SELECT worktree_path FROM sessions LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE sessions ADD COLUMN worktree_path TEXT');
}
try {
  db.prepare('SELECT worktree_branch FROM sessions LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE sessions ADD COLUMN worktree_branch TEXT');
}

// Migration: add max_turns to rooms
try {
  db.prepare('SELECT max_turns FROM rooms LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE rooms ADD COLUMN max_turns INTEGER NOT NULL DEFAULT 10');
}

// Migration: add attachments column to messages (JSON array of image metadata)
try {
  db.prepare('SELECT attachments FROM messages LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT');
}

// Migration: add attachments column to room_messages
try {
  db.prepare('SELECT attachments FROM room_messages LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE room_messages ADD COLUMN attachments TEXT');
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
    config.defaultCwd,
    1
  );
  insertCron.run(
    'job-search-monitor',
    '0 8 * * 1-5',
    'Search for senior full-stack software engineer remote jobs. Check Gmail for any job application responses. Search LinkedIn for new postings matching: Python, Django, TypeScript, React, AWS, healthcare. Summarize findings.',
    config.defaultCwd,
    0
  );
}

// Prepared statements
const stmts = {
  // Sessions
  createSession: db.prepare(
    'INSERT INTO sessions (id, agent_id, name, engine, model, use_worktree) VALUES (?, ?, ?, ?, ?, ?)'
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
  updateSessionWorktree: db.prepare(
    "UPDATE sessions SET use_worktree = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  updateSessionWorktreePath: db.prepare(
    "UPDATE sessions SET worktree_path = ?, worktree_branch = ?, updated_at = datetime('now') WHERE id = ?"
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
    'INSERT INTO messages (id, session_id, role, content, engine, model, attachments) VALUES (?, ?, ?, ?, ?, ?, ?)'
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

  // Cron logs
  addCronLog: db.prepare(
    'INSERT INTO cron_logs (cron_id, status) VALUES (?, ?)'
  ),
  updateCronLog: db.prepare(
    'UPDATE cron_logs SET result = ?, status = ?, duration_ms = ? WHERE id = ?'
  ),
  getCronLogs: db.prepare(
    'SELECT * FROM cron_logs WHERE cron_id = ? ORDER BY timestamp DESC LIMIT ?'
  ),
  pruneCronLogs: db.prepare(
    `DELETE FROM cron_logs WHERE cron_id = ? AND id NOT IN (
       SELECT id FROM cron_logs WHERE cron_id = ? ORDER BY timestamp DESC LIMIT 100
     )`
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

  // Rooms
  getRooms: db.prepare('SELECT * FROM rooms ORDER BY updated_at DESC'),
  getRoom: db.prepare('SELECT * FROM rooms WHERE id = ?'),
  createRoom: db.prepare(
    'INSERT INTO rooms (id, name) VALUES (?, ?)'
  ),
  updateRoomName: db.prepare(
    "UPDATE rooms SET name = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  updateRoomMaxTurns: db.prepare(
    "UPDATE rooms SET max_turns = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  touchRoom: db.prepare(
    "UPDATE rooms SET updated_at = datetime('now') WHERE id = ?"
  ),
  deleteRoom: db.prepare('DELETE FROM rooms WHERE id = ?'),

  // Room agents
  getRoomAgents: db.prepare(
    'SELECT * FROM room_agents WHERE room_id = ? ORDER BY position ASC'
  ),
  addRoomAgent: db.prepare(
    `INSERT OR IGNORE INTO room_agents (room_id, agent_id, position)
     VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM room_agents WHERE room_id = ?))`
  ),
  removeRoomAgent: db.prepare(
    'DELETE FROM room_agents WHERE room_id = ? AND agent_id = ?'
  ),

  // Room messages
  getRoomMessages: db.prepare(
    'SELECT * FROM room_messages WHERE room_id = ? ORDER BY created_at ASC'
  ),
  addRoomMessage: db.prepare(
    'INSERT INTO room_messages (id, room_id, role, agent_id, agent_name, agent_color, content, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
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

  // Delegations
  createDelegation: db.prepare(
    `INSERT INTO delegations (id, session_id, parent_message_id, agent_id, agent_name, task, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`
  ),
  updateDelegation: db.prepare(
    `UPDATE delegations SET status = ?, output = ?, error = ?, completed_at = datetime('now') WHERE id = ?`
  ),
  getDelegations: db.prepare(
    'SELECT * FROM delegations WHERE parent_message_id = ? ORDER BY started_at ASC'
  ),
  getDelegationsBySession: db.prepare(
    'SELECT * FROM delegations WHERE session_id = ? ORDER BY started_at DESC'
  ),
};

export { db, stmts };
