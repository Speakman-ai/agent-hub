import Database from 'better-sqlite3';
import path from 'path';
import config from './config.js';

let db;
let stmts;

// Registry of opened db handles, keyed by dataDir. We deliberately keep prior
// connections open across org switches so in-flight CLI streams (which captured
// a reference to the old `stmts` object before the switch) can finish writing
// to their original database. Closing on switch would invalidate their prepared
// statements and crash the server with "database is closed" / FK errors.
const dbRegistry = new Map(); // dataDir -> { db, stmts }

/**
 * Initialize (or switch to) the database at the given data directory.
 * Creates tables, runs migrations, and prepares all statements on first use.
 * Subsequent calls for the same dataDir reuse the cached handle. Switching to
 * a different dataDir does NOT close the previous one.
 */
function initDb(dataDir) {
  // Reuse a previously opened handle if we have one for this dir.
  const cached = dbRegistry.get(dataDir);
  if (cached) {
    db = cached.db;
    stmts = cached.stmts;
    return;
  }

  const dbPath = path.join(dataDir, 'agent-hub.db');
  db = new Database(dbPath);

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
      project_id TEXT,
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

    CREATE TABLE IF NOT EXISTS background_tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','error')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_background_tasks_status ON background_tasks(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS message_queue (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments TEXT,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_message_queue_session ON message_queue(session_id, position ASC);

    CREATE TABLE IF NOT EXISTS device_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL DEFAULT 'ios',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used TEXT
    );

    -- Kanban boards: one per project
    CREATE TABLE IF NOT EXISTS kanban_boards (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_boards_project ON kanban_boards(project_id);

    -- Kanban columns: ordered lanes within a board
    CREATE TABLE IF NOT EXISTS kanban_columns (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      color TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (board_id) REFERENCES kanban_boards(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_columns_board ON kanban_columns(board_id);

    -- Kanban cards: tasks on the board
    CREATE TABLE IF NOT EXISTS kanban_cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL,
      board_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
      assignee TEXT,
      labels TEXT,
      session_id TEXT,
      github_issue_url TEXT,
      created_by TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (column_id) REFERENCES kanban_columns(id) ON DELETE CASCADE,
      FOREIGN KEY (board_id) REFERENCES kanban_boards(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_cards_column ON kanban_cards(column_id);
    CREATE INDEX IF NOT EXISTS idx_kanban_cards_board ON kanban_cards(board_id);

    -- Kanban card comments
    CREATE TABLE IF NOT EXISTS kanban_card_comments (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (card_id) REFERENCES kanban_cards(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_comments_card ON kanban_card_comments(card_id);

    CREATE TABLE IF NOT EXISTS webhook_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_configs_project ON webhook_configs(project_id);

    CREATE TABLE IF NOT EXISTS webhook_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_config_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      action TEXT,
      delivery_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','success','error','skipped')),
      result TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (webhook_config_id) REFERENCES webhook_configs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_logs_config ON webhook_logs(webhook_config_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_logs_created ON webhook_logs(created_at DESC);

    -- Wiki pages: per-project knowledge base with full-text search
    CREATE TABLE IF NOT EXISTS wiki_pages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'general',
      updated_by TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_project ON wiki_pages(project_id);
    CREATE INDEX IF NOT EXISTS idx_wiki_category ON wiki_pages(project_id, category);
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

  // Migration: add project_id to rooms (links room to a project)
  try {
    db.prepare('SELECT project_id FROM rooms LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE rooms ADD COLUMN project_id TEXT');
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

  // Migration: add cron_id to sessions (links session to a cron job)
  try {
    db.prepare('SELECT cron_id FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN cron_id INTEGER');
  }

  // Migration: create wiki FTS5 index if wiki_pages table exists
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages_fts USING fts5(
        title, content, slug UNINDEXED, project_id UNINDEXED,
        content_rowid='rowid'
      );
    `);
  } catch (e) {
    console.warn('[wiki] FTS5 creation failed (may already exist):', e.message);
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
  stmts = {
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

    // Background tasks
    insertBackgroundTask: db.prepare(
      `INSERT INTO background_tasks (id, session_id, agent_id, prompt) VALUES (?, ?, ?, ?)`
    ),
    updateBackgroundTaskStatus: db.prepare(
      `UPDATE background_tasks SET status = ?, completed_at = datetime('now') WHERE id = ?`
    ),
    getBackgroundTask: db.prepare('SELECT * FROM background_tasks WHERE id = ?'),
    getBackgroundTaskBySession: db.prepare('SELECT * FROM background_tasks WHERE session_id = ?'),
    getBackgroundTasks: db.prepare(
      'SELECT * FROM background_tasks ORDER BY created_at DESC LIMIT ?'
    ),
    getRunningBackgroundTasks: db.prepare(
      `SELECT * FROM background_tasks WHERE status = 'running' ORDER BY created_at DESC`
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
    createProjectRoom: db.prepare(
      'INSERT INTO rooms (id, name, project_id) VALUES (?, ?, ?)'
    ),
    getRoomByProjectId: db.prepare(
      'SELECT * FROM rooms WHERE project_id = ? LIMIT 1'
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

    // Message queue
    enqueueMessage: db.prepare(
      'INSERT INTO message_queue (id, session_id, agent_id, content, attachments, position) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    getQueuedMessages: db.prepare(
      'SELECT * FROM message_queue WHERE session_id = ? ORDER BY position ASC'
    ),
    getNextQueuedMessage: db.prepare(
      'SELECT * FROM message_queue WHERE session_id = ? ORDER BY position ASC LIMIT 1'
    ),
    dequeueMessage: db.prepare(
      'DELETE FROM message_queue WHERE id = ?'
    ),
    clearSessionQueue: db.prepare(
      'DELETE FROM message_queue WHERE session_id = ?'
    ),
    getMaxQueuePosition: db.prepare(
      'SELECT MAX(position) as max_pos FROM message_queue WHERE session_id = ?'
    ),
    updateQueueMessage: db.prepare(
      'UPDATE message_queue SET content = ? WHERE id = ?'
    ),
    updateMessageContent: db.prepare(
      'UPDATE messages SET content = ? WHERE id = ?'
    ),
    getAllQueuedSessions: db.prepare(
      'SELECT DISTINCT session_id FROM message_queue'
    ),

    // Cron sessions
    getSessionByCronId: db.prepare(
      'SELECT * FROM sessions WHERE cron_id = ? LIMIT 1'
    ),
    getAllCronSessions: db.prepare(
      `SELECT s.*, c.name as cron_name, c.schedule as cron_schedule
       FROM sessions s JOIN crons c ON s.cron_id = c.id
       ORDER BY s.updated_at DESC`
    ),
    updateSessionCronId: db.prepare(
      'UPDATE sessions SET cron_id = ? WHERE id = ?'
    ),

    // Device tokens (push notifications)
    registerDeviceToken: db.prepare(
      `INSERT INTO device_tokens (token, platform, last_used)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(token) DO UPDATE SET
         platform = excluded.platform,
         last_used = datetime('now')`
    ),
    removeDeviceToken: db.prepare(
      'DELETE FROM device_tokens WHERE token = ?'
    ),
    getAllDeviceTokens: db.prepare(
      'SELECT * FROM device_tokens'
    ),
    updateDeviceTokenLastUsed: db.prepare(
      "UPDATE device_tokens SET last_used = datetime('now') WHERE token = ?"
    ),

    // Kanban boards
    getKanbanBoard: db.prepare('SELECT * FROM kanban_boards WHERE project_id = ? LIMIT 1'),
    getKanbanBoardById: db.prepare('SELECT * FROM kanban_boards WHERE id = ?'),
    createKanbanBoard: db.prepare('INSERT INTO kanban_boards (id, project_id, name) VALUES (?, ?, ?)'),
    deleteKanbanBoard: db.prepare('DELETE FROM kanban_boards WHERE id = ?'),

    // Kanban columns
    getKanbanColumns: db.prepare('SELECT * FROM kanban_columns WHERE board_id = ? ORDER BY position ASC'),
    createKanbanColumn: db.prepare('INSERT INTO kanban_columns (id, board_id, name, position, color) VALUES (?, ?, ?, ?, ?)'),
    updateKanbanColumn: db.prepare("UPDATE kanban_columns SET name = ?, position = ?, color = ? WHERE id = ?"),
    deleteKanbanColumn: db.prepare('DELETE FROM kanban_columns WHERE id = ?'),

    // Kanban cards
    getKanbanCards: db.prepare('SELECT * FROM kanban_cards WHERE board_id = ? ORDER BY position ASC'),
    getKanbanCardsByColumn: db.prepare('SELECT * FROM kanban_cards WHERE column_id = ? ORDER BY position ASC'),
    getKanbanCard: db.prepare('SELECT * FROM kanban_cards WHERE id = ?'),
    createKanbanCard: db.prepare(
      `INSERT INTO kanban_cards (id, column_id, board_id, title, description, priority, assignee, labels, session_id, github_issue_url, created_by, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    updateKanbanCard: db.prepare(
      `UPDATE kanban_cards SET title = ?, description = ?, priority = ?, assignee = ?, labels = ?, session_id = ?, github_issue_url = ?, updated_at = datetime('now') WHERE id = ?`
    ),
    moveKanbanCard: db.prepare(
      `UPDATE kanban_cards SET column_id = ?, position = ?, updated_at = datetime('now') WHERE id = ?`
    ),
    deleteKanbanCard: db.prepare('DELETE FROM kanban_cards WHERE id = ?'),

    // Kanban card comments
    getKanbanCardComments: db.prepare('SELECT * FROM kanban_card_comments WHERE card_id = ? ORDER BY created_at ASC'),
    createKanbanCardComment: db.prepare('INSERT INTO kanban_card_comments (id, card_id, author, content) VALUES (?, ?, ?, ?)'),
    deleteKanbanCardComment: db.prepare('DELETE FROM kanban_card_comments WHERE id = ?'),

    // Webhook configs
    getWebhookConfigs: db.prepare('SELECT * FROM webhook_configs ORDER BY created_at DESC'),
    getWebhookConfigsByProject: db.prepare('SELECT * FROM webhook_configs WHERE project_id = ? ORDER BY created_at DESC'),
    getWebhookConfig: db.prepare('SELECT * FROM webhook_configs WHERE id = ?'),
    createWebhookConfig: db.prepare('INSERT INTO webhook_configs (project_id, repo_url, secret, events, enabled) VALUES (?, ?, ?, ?, ?)'),
    updateWebhookConfig: db.prepare("UPDATE webhook_configs SET repo_url = ?, events = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?"),
    deleteWebhookConfig: db.prepare('DELETE FROM webhook_configs WHERE id = ?'),
    addWebhookLog: db.prepare('INSERT INTO webhook_logs (webhook_config_id, event_type, action, delivery_id, status) VALUES (?, ?, ?, ?, ?)'),
    updateWebhookLog: db.prepare('UPDATE webhook_logs SET status = ?, result = ?, duration_ms = ? WHERE id = ?'),
    getWebhookLogs: db.prepare('SELECT * FROM webhook_logs WHERE webhook_config_id = ? ORDER BY created_at DESC LIMIT ?'),
    getRecentWebhookLogs: db.prepare('SELECT wl.*, wc.repo_url FROM webhook_logs wl JOIN webhook_configs wc ON wl.webhook_config_id = wc.id ORDER BY wl.created_at DESC LIMIT ?'),

    // Wiki pages
    getWikiPages: db.prepare('SELECT id, project_id, title, slug, category, updated_by, created_at, updated_at FROM wiki_pages WHERE project_id = ? ORDER BY updated_at DESC'),
    getWikiPage: db.prepare('SELECT * FROM wiki_pages WHERE project_id = ? AND slug = ?'),
    getWikiPageById: db.prepare('SELECT * FROM wiki_pages WHERE id = ?'),
    createWikiPage: db.prepare('INSERT INTO wiki_pages (id, project_id, title, slug, content, category, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    updateWikiPage: db.prepare("UPDATE wiki_pages SET title = ?, content = ?, category = ?, updated_by = ?, updated_at = datetime('now') WHERE project_id = ? AND slug = ?"),
    deleteWikiPage: db.prepare('DELETE FROM wiki_pages WHERE project_id = ? AND slug = ?'),
    getWikiPagesByCategory: db.prepare('SELECT id, project_id, title, slug, category, updated_by, created_at, updated_at FROM wiki_pages WHERE project_id = ? AND category = ? ORDER BY updated_at DESC'),
  };

  // Cache for future switches.
  dbRegistry.set(dataDir, { db, stmts });
}

/** Return the currently active stmts object (live, not pinned). */
function getActiveStmts() {
  return stmts;
}

// Initialize on import with default config
initDb(config.dataDir);

export { db, stmts, initDb, getActiveStmts };
