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
`);

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
