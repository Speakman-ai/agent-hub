import Database from 'better-sqlite3';
import path from 'path';
import config from './config.js';
import { WORKFLOWS_SCHEMA, WORKFLOWS_WEBHOOK_PATH_INDEX_SQL } from './workflows-schema.js';
import {
  WORKTREE_PREVIEWS_SCHEMA,
  WORKTREE_PREVIEW_GROUPS_SCHEMA,
  MIGRATE_LEGACY_PREVIEWS_SQL,
} from './preview/preview-schema.js';
import { WORKTREE_PREVIEW_SECRETS_SCHEMA } from './preview/preview-secrets-schema.js';
import type { Stmts } from './types.js';

let db: Database.Database | undefined;
let stmts: Stmts | undefined;

// Registry of opened db handles, keyed by dataDir. We deliberately keep prior
// connections open across org switches so in-flight CLI streams (which captured
// a reference to the old `stmts` object before the switch) can finish writing
// to their original database. Closing on switch would invalidate their prepared
// statements and crash the server with "database is closed" / FK errors.
const dbRegistry = new Map<string, { db: Database.Database; stmts: Stmts }>();

/**
 * Initialize (or switch to) the database at the given data directory.
 * Creates tables, runs migrations, and prepares all statements on first use.
 * Subsequent calls for the same dataDir reuse the cached handle. Switching to
 * a different dataDir does NOT close the previous one.
 */
function initDb(dataDir: string): void {
  const cached = dbRegistry.get(dataDir);
  if (cached) {
    db = cached.db;
    stmts = cached.stmts;
    return;
  }

  const dbPath = path.join(dataDir, 'agent-hub.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Migration: drop legacy threads/thread_entries tables that lack project_id
  // (created by an older schema before the threads feature was redesigned).
  {
    const cols = (db.pragma('table_info(threads)') as { name: string }[]).map((c) => c.name);
    if (cols.length > 0 && !cols.includes('project_id')) {
      db.exec('DROP TABLE IF EXISTS thread_entries');
      db.exec('DROP TABLE IF EXISTS threads');
    }
  }

  // Migration: drop legacy preview tables from the Docker-based preview
  // system (replaced by pr_captures / pr_capture_artifacts). Safe if they
  // don't exist.
  db.exec('DROP TABLE IF EXISTS preview_captures');
  db.exec('DROP TABLE IF EXISTS preview_containers');

  // Migration: drop legacy session-watchdog tables. The feature was an
  // experimental server-side stall detector with a re-engagement ladder;
  // operator feedback found the nudges noisy and unhelpful in practice, so
  // the whole subsystem (cron, hooks, routes, schema) was removed. Safe if
  // the tables don't exist.
  db.exec('DROP TABLE IF EXISTS watchdog_events');
  db.exec('DROP TABLE IF EXISTS session_watchdog');

  // Pre-bootstrap migration: P1 webhook_events columns (pr_key, deferred_until,
  // superseded_by). MUST run before the bootstrap `db.exec` below because that
  // block contains `CREATE INDEX … ON webhook_events(pr_key, …)` — and on
  // existing installs `CREATE TABLE IF NOT EXISTS webhook_events` is a no-op,
  // so the index would reference a column that doesn't exist yet and throw
  // `SqliteError: no such column: pr_key` (root-caused 2026-05-07 deploy
  // outage on dev + prod). The post-bootstrap migration block further down
  // also needs these columns for the CHECK-constraint rebuild, so adding them
  // here is strictly earlier — fresh installs skip the ALTER (no table) and
  // the bootstrap CREATE TABLE creates them inline; legacy installs get the
  // columns added before any index references them. ALTER TABLE on a missing
  // table throws "no such table" which the try/catch swallows safely.
  for (const col of ['pr_key TEXT', 'deferred_until TEXT', 'superseded_by INTEGER']) {
    try {
      db.exec(`ALTER TABLE webhook_events ADD COLUMN ${col}`);
    } catch (_e) {
      /* table doesn't exist yet (fresh install) or column already present */
    }
  }

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
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
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
      timeout_ms INTEGER,
      notify_on_run INTEGER NOT NULL DEFAULT 0,
      engine TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

    -- Multi-agent sessions: advisors beyond sessions.agent_id (primary executor)
    CREATE TABLE IF NOT EXISTS session_agents (
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, agent_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_session_agents_session ON session_agents(session_id);

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

    -- DB-backed Slack bot configurations (UI-managed alternative to slack-config.json).
    CREATE TABLE IF NOT EXISTS slack_bots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      bot_token TEXT NOT NULL,
      app_token TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      channel_map TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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

    -- session_progress: per-session Cursor-style progress checklist. One row
    -- per step emitted by a long-running session (reviewer, autofix, etc.)
    -- via a [[STEP:...]] marker. Rehydrates the in-Hub ProgressPanel when
    -- a session is reopened. started_at / finished_at are epoch ms so we
    -- don't have to do the SQLite naive-datetime timezone dance that pr_state
    -- had to fix up in review.
    CREATE TABLE IF NOT EXISTS session_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      message_id TEXT,
      step TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('started','completed','failed')),
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_session_progress_session
      ON session_progress(session_id, started_at ASC);

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

    -- Handoffs: tracks async session handoff from one agent to another via
    -- the <handoff> block protocol. One handoff row per emitted block; the
    -- target session is created lazily so to_session_id is nullable until
    -- the handler links them.
    CREATE TABLE IF NOT EXISTS handoffs (
      id TEXT PRIMARY KEY,
      from_session_id TEXT NOT NULL,
      to_session_id TEXT,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','failed')),
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT,
      FOREIGN KEY (from_session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_handoffs_from_session ON handoffs(from_session_id);
    CREATE INDEX IF NOT EXISTS idx_handoffs_to_session ON handoffs(to_session_id);

    -- Skill invocations: emitted whenever an agent requests a skill load via
    -- <agenthub:skill>. Stores load status + payload size for observability.
    CREATE TABLE IF NOT EXISTS skill_invocations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      source TEXT,
      reason TEXT,
      status TEXT NOT NULL CHECK(status IN ('loaded','not-found','malformed')),
      injected_bytes INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_skill_invocations_session ON skill_invocations(session_id);

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

    -- Checkpoints: Claude Code auto-save restore points per session.
    -- Each user turn creates a checkpoint identified by its UUID. The UI can
    -- display these and trigger file-level rewinds.
    CREATE TABLE IF NOT EXISTS checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      message_id TEXT,
      uuid TEXT NOT NULL,
      turn_index INTEGER,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at ASC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_checkpoints_uuid ON checkpoints(uuid);

    CREATE TABLE IF NOT EXISTS device_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL DEFAULT 'ios',
      user_id TEXT,
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

    -- Kanban epics: grouping layer above cards
    CREATE TABLE IF NOT EXISTS kanban_epics (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      color TEXT NOT NULL DEFAULT '#6366F1',
      autonomous INTEGER NOT NULL DEFAULT 0,
      autonomous_interval INTEGER NOT NULL DEFAULT 5,
      autonomous_max_concurrent INTEGER NOT NULL DEFAULT 2,
      autonomous_model TEXT DEFAULT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (board_id) REFERENCES kanban_boards(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_epics_board ON kanban_epics(board_id);

    -- Card-to-card blocker relationships (many-to-many).
    -- A row means card_id is blocked by blocked_by_card_id. Cycle prevention
    -- is enforced at the application layer (see server/kanban-blockers.ts);
    -- SQLite has no native recursive constraint. UNIQUE prevents duplicate
    -- links; CHECK prevents trivial self-blocks. Cascade on card delete.
    CREATE TABLE IF NOT EXISTS kanban_card_blockers (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      blocked_by_card_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(card_id, blocked_by_card_id),
      CHECK (card_id != blocked_by_card_id),
      FOREIGN KEY (card_id) REFERENCES kanban_cards(id) ON DELETE CASCADE,
      FOREIGN KEY (blocked_by_card_id) REFERENCES kanban_cards(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_card_blockers_card
      ON kanban_card_blockers(card_id);
    CREATE INDEX IF NOT EXISTS idx_kanban_card_blockers_blocked_by
      ON kanban_card_blockers(blocked_by_card_id);

    CREATE TABLE IF NOT EXISTS webhook_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      author_allowlist TEXT NOT NULL DEFAULT '[]',
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

    -- Webhook events queue: raw delivered events awaiting async processing.
    -- Writes here from the fast-ack handler; a background worker claims rows
    -- for kanban lifecycle + Claude prompt execution. Keeps the HTTP handler
    -- off the hot path (see: webhook starvation incident, 2026-04-16).
    --
    -- P1 dedup/concurrency (card 2c4a0d06): three columns layer on top of
    -- the P0 fast-ack design:
    --   * pr_key         -- "<repo_full_name>:<pr_number>" for PR-scoped events.
    --                       The worker never claims two rows with the same
    --                       pr_key concurrently (per-PR serialization).
    --   * deferred_until -- persistent debounce. The worker won't claim rows
    --                       whose deferred_until is still in the future.
    --                       Replaces in-memory reviewerDebounceTimers so
    --                       debounce state survives restart.
    --   * superseded_by  -- coalescing audit trail. When a newer row for the
    --                       same (event_type, action, pr_key) arrives, older
    --                       pending rows are flipped to status='skipped' with
    --                       superseded_by pointing at the newer row.
    CREATE TABLE IF NOT EXISTS webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_config_id INTEGER NOT NULL,
      delivery_id TEXT,
      event_type TEXT NOT NULL,
      action TEXT,
      payload TEXT NOT NULL,
      signature TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','processing','done','error','skipped')),
      started_at TEXT,
      completed_at TEXT,
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      pr_key TEXT,
      deferred_until TEXT,
      superseded_by INTEGER,
      FOREIGN KEY (webhook_config_id) REFERENCES webhook_configs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events(status, created_at);
    -- Partial unique index: idempotency on GitHub's x-github-delivery header
    -- when present. NULL delivery_ids are allowed to repeat (legacy / manual replays).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_delivery
      ON webhook_events(delivery_id)
      WHERE delivery_id IS NOT NULL;
    -- Per-key concurrency cap query: looks up "any row for this pr_key
    -- currently processing?" The partial-index condition keeps it tight so
    -- the index is useful even with millions of completed rows over time.
    CREATE INDEX IF NOT EXISTS idx_webhook_events_pr_key_active
      ON webhook_events(pr_key, status)
      WHERE pr_key IS NOT NULL AND status IN ('pending','processing');
    -- Deferred-until claim path: only the rows that are still waiting on a
    -- debounce window need an index. Fully-claimed rows drop out.
    CREATE INDEX IF NOT EXISTS idx_webhook_events_deferred
      ON webhook_events(deferred_until)
      WHERE deferred_until IS NOT NULL AND status = 'pending';

    -- Skill registry: central catalog of available skills
    CREATE TABLE IF NOT EXISTS skill_registry (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'general',
      author TEXT,
      source_url TEXT,
      repo_url TEXT,
      version TEXT,
      install_count INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_skill_registry_category ON skill_registry(category);

    -- Per-agent skill overrides (enable/disable specific skills)
    CREATE TABLE IF NOT EXISTS agent_skill_overrides (
      agent_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (agent_id, skill_id)
    );

    -- Notes: per-project rich markdown notes
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id);

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

    -- Threads: group log entries for cron runs, heartbeat checks, etc.
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('cron', 'heartbeat')),
      source_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id);
    CREATE INDEX IF NOT EXISTS idx_threads_type ON threads(project_id, type);
    CREATE INDEX IF NOT EXISTS idx_threads_source ON threads(project_id, source_id);

    -- Thread entries: individual log lines within a thread.
    -- Historically single-writer (heartbeat/cron daemons). The columns
    -- author_user_id, author_agent_id, and role were added when humans
    -- started posting through the chatroom composer; daemon writes
    -- leave role at its DEFAULT 'system' so existing call sites keep
    -- working. See server/routes/threads.ts and the corresponding
    -- migration block above for the existing-install ALTER TABLEs.
    CREATE TABLE IF NOT EXISTS thread_entries (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      author_user_id TEXT,
      author_agent_id TEXT,
      role TEXT NOT NULL DEFAULT 'system' CHECK(role IN ('system','user','assistant')),
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_thread_entries_thread ON thread_entries(thread_id);

    -- Note processings: tracks notes sent to agents for incorporation into knowledge
    CREATE TABLE IF NOT EXISTS note_processings (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      note_date TEXT NOT NULL,
      note_excerpt TEXT NOT NULL DEFAULT '',
      target TEXT NOT NULL DEFAULT 'auto' CHECK(target IN ('auto', 'wiki', 'memory', 'plan')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'success', 'error')),
      result TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_note_processings_project ON note_processings(project_id);
    CREATE INDEX IF NOT EXISTS idx_note_processings_date ON note_processings(project_id, note_date);

    -- Escalations: notifications requiring human intervention
    CREATE TABLE IF NOT EXISTS escalations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('merge_conflict','ci_failure','review_needed','blocker')),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      pr_number INTEGER,
      pr_url TEXT,
      card_id TEXT,
      source TEXT,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_escalations_project ON escalations(project_id);
    CREATE INDEX IF NOT EXISTS idx_escalations_type ON escalations(project_id, type);
    CREATE INDEX IF NOT EXISTS idx_escalations_ack ON escalations(acknowledged);

    -- iOS builds: Xcode builds on macOS VMs for PR preview
    CREATE TABLE IF NOT EXISTS ios_builds (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      pr_url TEXT,
      branch TEXT NOT NULL,
      commit_sha TEXT,
      repo_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','provisioning','building','archiving','uploading','ready','error','cancelled')),
      error_message TEXT,
      build_log TEXT,
      vm_instance_id TEXT,
      ipa_url TEXT,
      install_url TEXT,
      simulator_recording_url TEXT,
      qr_code_url TEXT,
      duration_seconds INTEGER,
      xcode_version TEXT,
      ios_sdk_version TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ios_builds_project ON ios_builds(project_id);
    CREATE INDEX IF NOT EXISTS idx_ios_builds_pr ON ios_builds(project_id, pr_number);
    CREATE INDEX IF NOT EXISTS idx_ios_builds_status ON ios_builds(status);

    -- iOS build artifacts: IPAs, simulator recordings, screenshots, logs
    CREATE TABLE IF NOT EXISTS ios_build_artifacts (
      id TEXT PRIMARY KEY,
      build_id TEXT NOT NULL REFERENCES ios_builds(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('ipa', 'simulator_recording', 'screenshot', 'log')),
      name TEXT NOT NULL,
      label TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ios_build_artifacts_build ON ios_build_artifacts(build_id);

    -- Finalize Code Changes runs -- pre-PR validation pipeline.
    -- See wiki finalize-code-changes-architecture-v0 (section 4 for the full
    -- schema and lifecycle). Phase 1 (this commit) only writes the rebase
    -- phase; later phases add review, tasks, dispatching, push. The columns
    -- are populated up-front so we do not have to ratchet the schema for
    -- every phase that lands.
    --
    -- Idempotency: re-triggering finalize with the same
    -- (project_id, branch, head_sha) reuses the in-flight row via
    -- idempotency_key = sha256(project_id|branch|head_sha) enforced by the
    -- UNIQUE constraint. A new commit on the branch (new head_sha) opens a
    -- new row. The orchestrator owns the upsert; this table is the audit log.
    CREATE TABLE IF NOT EXISTS finalize_runs (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      session_id TEXT,
      project_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      phase TEXT,
      trigger_source TEXT NOT NULL,
      worktree_path TEXT,
      triggered_by_user_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_email TEXT NOT NULL,
      reviewer_verdict TEXT,
      failure_reason TEXT,
      failed_step_index INTEGER,
      failed_step_name TEXT,
      failed_step_exit_code INTEGER,
      retry_of_run_id TEXT,
      active_seconds_consumed INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      pr_url TEXT
    );
    CREATE INDEX IF NOT EXISTS finalize_runs_card ON finalize_runs(card_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS finalize_runs_session ON finalize_runs(session_id);

    -- Reviewer threads — diff-anchored cold-eye-reviewer comments produced
    -- during the review phase of a Finalize run. Read-only at v0: the UI
    -- renders them as a side panel; replies happen in session chat. The
    -- reviewer's verdict (approved / changes_requested) lives on the parent
    -- finalize_runs row; this table only stores the per-finding notes.
    -- See wiki: finalize-code-changes-architecture-v0 (§8).
    CREATE TABLE IF NOT EXISTS reviewer_threads (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES finalize_runs(id),
      file_path TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      body TEXT NOT NULL,
      author TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reviewer_threads_run
      ON reviewer_threads(run_id, file_path, line_start);
  `);

  try {
    db.prepare('SELECT next_run_at FROM crons LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE crons ADD COLUMN next_run_at TEXT');
  }

  try {
    db.prepare('SELECT timeout_ms FROM crons LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE crons ADD COLUMN timeout_ms INTEGER');
  }

  // Per-cron opt-in for "ran successfully" push notifications. Existing
  // installs default to 0 (off) — historically every cron sent a push every
  // time it ran, which mobile users complained about. New installs and
  // existing rows both start opted-out; users explicitly enable on the
  // crons that should still notify.
  try {
    db.prepare('SELECT notify_on_run FROM crons LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE crons ADD COLUMN notify_on_run INTEGER NOT NULL DEFAULT 0');
  }

  // Per-cron model selection. Nullable — when unset the cron runs with the
  // engine default (`defaultModelForEngine('claude-code')`). Stored as a free-
  // form TEXT column so a future allowlist change doesn't strand existing
  // rows; the API validates on write against `config.engineValidModels`.
  try {
    db.prepare('SELECT model FROM crons LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE crons ADD COLUMN model TEXT');
  }

  // Cron runs are not tied to a session agent; this column + optional
  // project.cronSkillPrincipalAgentId pick whose skill toggles govern spawn
  // credential merge (see cron-skill-principal.ts).
  try {
    db.prepare('SELECT skill_principal_agent_id FROM crons LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE crons ADD COLUMN skill_principal_agent_id TEXT');
  }

  // Per-cron engine selection. Nullable — when unset, `runCronJob` first looks
  // at the resolved skill principal agent's `engine` (so a cron on a Cursor
  // project follows that agent without extra config) and finally falls back
  // to `claude-code` (the historical default for crons). Stored as a free-
  // form TEXT column so the engine list can grow without breaking existing
  // rows; the API validates against `ALL_SUPPORTED_ENGINES` on write, and
  // model selection is validated against the chosen engine's allowlist.
  try {
    db.prepare('SELECT engine FROM crons LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE crons ADD COLUMN engine TEXT');
  }

  // Threads-as-chatroom: thread_entries grew an author identity + role so
  // humans can post into the same thread the heartbeat / cron daemon
  // streams into. The fresh-install CREATE TABLE (above) carries the
  // CHECK(role IN …) constraint; existing installs get the columns
  // without the inline CHECK because SQLite can't add column-scope CHECK
  // via ALTER TABLE without a full table rebuild. Validity is enforced
  // at the app layer (only `createThreadEntry` / `createUserThreadEntry`
  // write the column, both with a fixed value).
  try {
    db.prepare('SELECT role FROM thread_entries LIMIT 1').get();
  } catch {
    db.exec("ALTER TABLE thread_entries ADD COLUMN role TEXT NOT NULL DEFAULT 'system'");
  }
  try {
    db.prepare('SELECT author_user_id FROM thread_entries LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE thread_entries ADD COLUMN author_user_id TEXT');
  }
  try {
    db.prepare('SELECT author_agent_id FROM thread_entries LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE thread_entries ADD COLUMN author_agent_id TEXT');
  }

  try {
    db.prepare('SELECT engine FROM sessions LIMIT 1').get();
  } catch {
    db.exec("ALTER TABLE sessions ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude-code'");
  }
  try {
    db.prepare('SELECT engine FROM messages LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE messages ADD COLUMN engine TEXT');
  }
  try {
    db.prepare('SELECT model FROM sessions LIMIT 1').get();
  } catch {
    db.exec("ALTER TABLE sessions ADD COLUMN model TEXT NOT NULL DEFAULT 'claude-opus-4-6'");
  }
  try {
    db.prepare('SELECT model FROM messages LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE messages ADD COLUMN model TEXT');
  }
  try {
    db.prepare('SELECT engine_session_id FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN engine_session_id TEXT');
  }

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

  try {
    db.prepare('SELECT git_worktree_detected FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN git_worktree_detected INTEGER DEFAULT NULL');
  }

  try {
    db.prepare('SELECT changes_ready FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN changes_ready TEXT DEFAULT NULL');
  }

  try {
    db.prepare('SELECT code_changed_at FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN code_changed_at TEXT DEFAULT NULL');
  }

  // Dedup column for the stale PR-creation notifier (see server/stale-pr-check.ts).
  // NULL means "never notified for the current changes_ready"; set to an ISO
  // timestamp once a push has been dispatched so the next cycle skips the row.
  // Cleared back to NULL whenever `changes_ready` is cleared, so a future
  // stale period re-fires.
  try {
    db.prepare('SELECT stale_pr_notified_at FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN stale_pr_notified_at TEXT DEFAULT NULL');
  }

  // Fixup: original migration used NOT NULL DEFAULT 0, which falsely marks pre-existing
  // sessions as "CLI confirmed not in worktree". Reset stale defaults to NULL (unknown).
  {
    const info = (db.pragma('table_info(sessions)') as { name: string; notnull: number }[]).find(
      (c) => c.name === 'git_worktree_detected',
    );
    if (info && info.notnull === 1) {
      db.exec('UPDATE sessions SET git_worktree_detected = NULL WHERE git_worktree_detected = 0');
    }
  }

  try {
    db.prepare('SELECT attachments FROM messages LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT');
  }

  // Nullable metadata column for system-role messages (e.g. PR-created markers).
  // Stores stringified JSON; plain user/assistant rows leave this NULL.
  try {
    db.prepare('SELECT metadata FROM messages LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE messages ADD COLUMN metadata TEXT');
  }

  // Relax the messages.role CHECK constraint to include 'system'. SQLite can't
  // ALTER a CHECK in place, so we rebuild the table when the stored DDL doesn't
  // already contain 'system'. Idempotent and runs inside a transaction so a
  // partial failure can't leave the schema half-migrated.
  {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
      .get() as { sql?: string } | undefined;
    const ddl = row?.sql ?? '';
    if (ddl && !/role[^)]*'system'/.test(ddl)) {
      const handle = db;
      handle.transaction(() => {
        handle.exec(`
          CREATE TABLE messages_new (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
            content TEXT NOT NULL,
            engine TEXT,
            model TEXT,
            attachments TEXT,
            metadata TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
          );
          INSERT INTO messages_new (id, session_id, role, content, engine, model, attachments, metadata, created_at)
            SELECT id, session_id, role, content, engine, model, attachments, NULL, created_at FROM messages;
          DROP TABLE messages;
          ALTER TABLE messages_new RENAME TO messages;
          CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
        `);
      })();
    }
  }

  try {
    db.prepare('SELECT cron_id FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN cron_id INTEGER');
  }

  try {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN epic_id TEXT');
  } catch (_e) {
    /* already exists */
  }

  try {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN documented INTEGER NOT NULL DEFAULT 0');
  } catch (_e) {
    /* already exists */
  }

  try {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN autonomous_iterations INTEGER NOT NULL DEFAULT 0');
  } catch (_e) {
    /* already exists */
  }

  try {
    db.exec('ALTER TABLE sessions ADD COLUMN ask_mode INTEGER NOT NULL DEFAULT 0');
  } catch (_e) {
    /* already exists */
  }

  try {
    db.exec('ALTER TABLE sessions ADD COLUMN react_loop_enabled INTEGER NOT NULL DEFAULT 1');
  } catch (_e) {
    /* already exists */
  }

  try {
    db.prepare('SELECT pending_skill_context FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN pending_skill_context TEXT DEFAULT NULL');
  }

  try {
    db.prepare('SELECT auto_ship_on_complete FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN auto_ship_on_complete INTEGER NOT NULL DEFAULT 0');
  }

  // Soft-delete ("archive") column. When set, the session is hidden from the
  // live `getSessions` list but remains in the DB for up to 24 hours so users
  // can restore it via POST /api/sessions/:sessionId/restore.
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN deleted_at TEXT DEFAULT NULL');
  } catch (_e) {
    /* already exists */
  }

  // One hybrid wiki embedding (Gemini) per session — tracked separately from
  // transcript row count so "Forward to agent" / pre-seeded sessions still get
  // a first-chance RAG on the first eligible long user message.
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN wiki_hybrid_rag_consumed INTEGER NOT NULL DEFAULT 0');
  } catch (_e) {
    /* already exists */
  }

  try {
    db.prepare('SELECT web_search_calls_used FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN web_search_calls_used INTEGER NOT NULL DEFAULT 0');
  }

  // 0 = legacy wiki hybrid gate (consumed was 0/1); 1 = monotonic call counter per session.
  try {
    db.prepare('SELECT wiki_hybrid_rag_budget_version FROM sessions LIMIT 1').get();
  } catch {
    db.exec(
      'ALTER TABLE sessions ADD COLUMN wiki_hybrid_rag_budget_version INTEGER NOT NULL DEFAULT 0',
    );
  }

  try {
    db.prepare('SELECT orchestration_phase FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN orchestration_phase TEXT DEFAULT NULL');
  }
  try {
    db.prepare('SELECT orchestration_meta FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN orchestration_meta TEXT DEFAULT NULL');
  }

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_deleted_at ON sessions(deleted_at)');
  } catch (_e) {
    /* already exists */
  }

  // Per-user session ownership (Phase 4). Logical reference to a row in the
  // shared orgs.db `users` table — kept as plain TEXT (not a FK) because the
  // users table lives in a different SQLite database. NULL is reserved for
  // legacy / pre-migration rows; runtime callers backfill via setSessionOwner.
  try {
    db.prepare('SELECT owner_user_id FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN owner_user_id TEXT DEFAULT NULL');
  }
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_user_id)');
  } catch (_e) {
    /* already exists */
  }

  // Multi-agent sessions: max advisor turns per user message round
  try {
    db.prepare('SELECT max_turns FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN max_turns INTEGER NOT NULL DEFAULT 10');
  }

  // Message attribution for multi-agent assistant turns
  try {
    db.prepare('SELECT agent_id FROM messages LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE messages ADD COLUMN agent_id TEXT');
    db.exec('ALTER TABLE messages ADD COLUMN agent_name TEXT');
    db.exec('ALTER TABLE messages ADD COLUMN agent_color TEXT');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_agents (
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, agent_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_session_agents_session ON session_agents(session_id);
  `);

  // Drop legacy conference room tables (replaced by multi-agent sessions).
  const legacyRoomTables = [
    'room_message_queue',
    'active_room_tasks',
    'room_messages',
    'room_agents',
    'rooms',
  ] as const;
  let legacyRoomRows = 0;
  for (const table of legacyRoomTables) {
    try {
      const row = db
        .prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name=?`)
        .get(table) as { c: number };
      if (row.c > 0) {
        const countRow = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
        legacyRoomRows += countRow.c;
      }
    } catch {
      /* table missing or unreadable */
    }
  }
  if (legacyRoomRows > 0) {
    console.warn(
      `[db] Dropping legacy conference-room tables (${legacyRoomRows} row(s) will be discarded). ` +
        'Export room history before upgrading if you need to keep it.',
    );
  }
  for (const table of legacyRoomTables) {
    try {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    } catch (_e) {
      /* best-effort */
    }
  }

  try {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN pr_url TEXT');
  } catch (_e) {
    /* already exists */
  }

  try {
    db.exec(
      "ALTER TABLE kanban_cards ADD COLUMN review_status TEXT DEFAULT NULL CHECK(review_status IN ('awaiting_review','reviewing','approved','changes_requested',NULL))",
    );
  } catch (_e) {
    /* already exists */
  }

  try {
    db.prepare('SELECT dispatched_by_autonomous FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec(
      'ALTER TABLE kanban_cards ADD COLUMN dispatched_by_autonomous INTEGER NOT NULL DEFAULT 0',
    );
    db.exec('UPDATE kanban_cards SET dispatched_by_autonomous = 1 WHERE autonomous_iterations > 0');
    db.exec(
      `UPDATE kanban_cards SET dispatched_by_autonomous = 1
       WHERE epic_id IS NOT NULL
       AND epic_id IN (SELECT id FROM kanban_epics WHERE autonomous = 1)
       AND dispatched_by_autonomous = 0`,
    );
  }

  try {
    db.prepare('SELECT assign_model FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN assign_model TEXT');
  }

  // Optional per-card override of the spawn engine. NULL = use the assignee
  // agent's engine (current default). Any string is one of the recognized
  // engine ids (`claude-code | cursor-agent | gemini-cli | codex-cli`). Set
  // alongside `assign_model` so a ticket assigned to a Claude agent can still
  // be run under codex-cli without reassigning to a different agent. The
  // engine is validated against `cfg.engineValidModels` keys at assign time;
  // an unknown engine yields HTTP 400. Wired into spawn paths via
  // `resolveEffectiveEngineAndModel({ explicitEngine })`. See wiki:
  // `kanban-card-model-override-assign-with-custom-model`.
  try {
    db.prepare('SELECT assign_engine FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN assign_engine TEXT');
  }

  // Triage routing — autonomous mode runs eligible cards through the project's
  // intake (or lead) agent before any specialist picks them up. Triage rewrites
  // description/AC and picks a suggested_assignee. `triaged_at` is the gate:
  // null = not yet triaged (skipped by dispatch); non-null = ready to dispatch.
  // See server/triage.ts and server/autonomous.ts (runOneShotTriagePass).
  try {
    db.prepare('SELECT triaged_at FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN triaged_at INTEGER DEFAULT NULL');
    // Backfill: any card that has already been dispatched once (autonomous
    // run, manual session, opened PR, or sitting in Review/Done) is treated
    // as already-triaged so the new triage gate doesn't silently halt boards
    // that turned autonomous mode on BEFORE this migration shipped.
    db.exec(
      `UPDATE kanban_cards
         SET triaged_at = strftime('%s','now') * 1000
       WHERE autonomous_iterations > 0
          OR session_id IS NOT NULL
          OR pr_url IS NOT NULL`,
    );
  }
  try {
    db.prepare('SELECT triaged_by FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN triaged_by TEXT DEFAULT NULL');
  }
  try {
    db.prepare('SELECT suggested_assignee FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN suggested_assignee TEXT DEFAULT NULL');
  }

  // Optional per-card override of the PR base branch. NULL = use repo default
  // (current behaviour). Any string is the explicit base branch the auto-PR
  // flow should target via `gh pr create --base <branch>`. The server falls
  // back to the default branch with an explanatory card comment if the chosen
  // base no longer exists at PR-open time.
  try {
    db.prepare('SELECT pr_base_branch FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN pr_base_branch TEXT DEFAULT NULL');
  }

  // Persistent dedup for `pollForMissedReviews`. Stores the highest GitHub
  // review id we have already dispatched author feedback for. Without this,
  // the in-memory `lastDispatchedReviewId` map is cleared on every server
  // restart, causing the same `changes_requested` reviews to be re-dispatched
  // repeatedly (each restart = a new unwanted "Missed Review Feedback" message
  // injected into the agent session). Persisting here means the poll can
  // restore its dedup state after restart without touching GitHub's API.
  try {
    db.prepare('SELECT last_dispatched_review_id FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN last_dispatched_review_id INTEGER DEFAULT NULL');
  }

  // Persistent dedup for `pollForMissedReviews`' CI-failure probe. Stores the
  // highest GitHub check_run id we have already dispatched a CI-fix message
  // for. Same restart-safety reasoning as `last_dispatched_review_id` above.
  try {
    db.prepare('SELECT last_dispatched_check_run_id FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec(
      'ALTER TABLE kanban_cards ADD COLUMN last_dispatched_check_run_id INTEGER DEFAULT NULL',
    );
  }

  // Persistent dedup for `pollForMissedReviews`' inline-comment probe. Stores
  // the highest GitHub pull-request review comment id we have already
  // dispatched author feedback for. Restart-safe like the siblings above.
  try {
    db.prepare('SELECT last_dispatched_review_comment_id FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec(
      'ALTER TABLE kanban_cards ADD COLUMN last_dispatched_review_comment_id INTEGER DEFAULT NULL',
    );
  }

  // Total number of autofix feedback dispatches sent to this card's session
  // (across review-feedback, CI-failure, inline-comment, and conflict kinds).
  // Used to:
  //   1. Stamp a "Autofix round N" banner into each dispatched message so the
  //      agent doesn't lose count and decide it's "been here too many times"
  //      after 3 rounds — a real, observed failure mode (see wiki:
  //      `Delegation — Lead Takeover When Sub-Agents Are Cancelled` and the
  //      autofix-stall conversation in today's notes).
  //   2. Emit structured log lines (`[Autofix] event=dispatch round=N ...`) so
  //      we can mine production logs for the dispatches-fired-vs-pushes-produced
  //      ratio and confirm whether iteration-3 stalls are structural or a
  //      prompt-drift artifact.
  try {
    db.prepare('SELECT autofix_dispatch_count FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec(
      'ALTER TABLE kanban_cards ADD COLUMN autofix_dispatch_count INTEGER NOT NULL DEFAULT 0',
    );
  }

  try {
    db.prepare('SELECT autonomous_model FROM kanban_epics LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_epics ADD COLUMN autonomous_model TEXT DEFAULT NULL');
  }

  try {
    db.prepare('SELECT orchestration_budgets_json FROM kanban_epics LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_epics ADD COLUMN orchestration_budgets_json TEXT DEFAULT NULL');
  }

  try {
    db.prepare('SELECT pr_base_branch FROM kanban_epics LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_epics ADD COLUMN pr_base_branch TEXT DEFAULT NULL');
  }

  // User id of whoever last flipped `autonomous = 1` on this epic. Used by
  // the autonomous-dispatch owner-resolution chain (see
  // `resolveAutonomousOwnerUserId` in server/session-ownership.ts) so that
  // sessions spawned for cards under this epic are attributed to the user
  // who turned autonomous mode on, when no card-level owner can be found.
  // NULL = legacy row OR autonomous mode was never enabled.
  try {
    db.prepare('SELECT autonomous_enabled_by FROM kanban_epics LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_epics ADD COLUMN autonomous_enabled_by TEXT DEFAULT NULL');
  }

  // Per-device push notification preferences. JSON array of enabled event
  // type strings; NULL = all events enabled (legacy default).
  try {
    db.prepare('SELECT enabled_events FROM device_tokens LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE device_tokens ADD COLUMN enabled_events TEXT DEFAULT NULL');
  }
  try {
    db.prepare('SELECT user_id FROM device_tokens LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE device_tokens ADD COLUMN user_id TEXT DEFAULT NULL');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS review_logs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      card_id TEXT,
      pr_url TEXT NOT NULL,
      reviewer_agent TEXT NOT NULL,
      author_agent TEXT,
      session_id TEXT,
      outcome TEXT NOT NULL CHECK(outcome IN ('approved','changes_requested','merge_conflict','ambiguous','timeout')),
      review_body TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_review_logs_project ON review_logs(project_id);
    CREATE INDEX IF NOT EXISTS idx_review_logs_card ON review_logs(card_id);
    CREATE INDEX IF NOT EXISTS idx_review_logs_pr ON review_logs(pr_url);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS pr_creation_logs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      card_id TEXT,
      session_id TEXT,
      pr_url TEXT NOT NULL,
      pr_number INTEGER,
      pr_title TEXT NOT NULL,
      author_agent TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pr_creation_logs_project ON pr_creation_logs(project_id);
    CREATE INDEX IF NOT EXISTS idx_pr_creation_logs_card ON pr_creation_logs(card_id);
    CREATE INDEX IF NOT EXISTS idx_pr_creation_logs_session ON pr_creation_logs(session_id);
  `);

  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_creation_logs_project_pr_url
     ON pr_creation_logs(project_id, pr_url)`,
  );

  // pr_state: per-PR reviewer run metadata, notably the GitHub Check Run id we
  // created for the live progress panel. Keyed by the canonical PR identity
  // (repo_full_name + pr_number). Each push (synchronize) rotates head_sha and
  // creates a fresh check_run_id — the row is upserted, not appended.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pr_state (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      repo_full_name TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      head_sha TEXT,
      check_run_id INTEGER,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','in_progress','completed')),
      conclusion TEXT,
      phase TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_state_repo_pr
      ON pr_state(repo_full_name, pr_number);
    CREATE INDEX IF NOT EXISTS idx_pr_state_project ON pr_state(project_id);
    CREATE INDEX IF NOT EXISTS idx_pr_state_check_run ON pr_state(check_run_id);
  `);

  try {
    db.exec('ALTER TABLE crons ADD COLUMN project_id TEXT');
  } catch (_e) {
    /* already exists */
  }

  // Per-webhook author allowlist — when non-empty, only PRs whose
  // pull_request.user.login matches (case-insensitive) trigger the reviewer.
  // Empty array (default) = review-all, backwards compatible.
  try {
    db.exec("ALTER TABLE webhook_configs ADD COLUMN author_allowlist TEXT NOT NULL DEFAULT '[]'");
  } catch (_e) {
    /* already exists */
  }

  db.exec(`
    -- Designs: Claude-Design-style canvas. Each design is a singleton-agent
    -- chat with an artifact directory on disk rendered in an iframe.
    CREATE TABLE IF NOT EXISTS designs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      org_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS design_projects (
      design_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      PRIMARY KEY (design_id, project_id),
      FOREIGN KEY (design_id) REFERENCES designs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS design_messages (
      id TEXT PRIMARY KEY,
      design_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (design_id) REFERENCES designs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_design_messages_design ON design_messages(design_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_design_projects_design ON design_projects(design_id);

    -- Provisioning jobs: one row per new-project scaffold. Events live in
    -- the orchestrator's in-memory ring buffer; we persist metadata + the
    -- terminal result so crashed jobs show up as 'running' (recoverable
    -- by the operator) instead of silently vanishing. See
    -- server/provisioning/orchestrator.ts for the event contract.
    CREATE TABLE IF NOT EXISTS provisioning_jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('running','succeeded','partial','failed')),
      repo_url TEXT,
      error_json TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_provisioning_jobs_project
      ON provisioning_jobs(project_id);

    -- Post-scaffold audit reports — one row per project (latest wins).
    -- Persisted so the Act IV landing page can re-render without
    -- re-running the audit. Schema is intentionally JSON-blob: the
    -- shape is owned by server/audit/audit-service.ts (AuditReport).
    CREATE TABLE IF NOT EXISTS project_audit_reports (
      project_id TEXT PRIMARY KEY,
      report_json TEXT NOT NULL,
      generated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-project agent roster — track id → agent id mapping persisted
    -- by the Act IV roster picker. Future autonomous-dispatch reads
    -- from here to know who owns each track. JSON-blob keeps the
    -- table flat while letting the picker evolve track shape freely.
    CREATE TABLE IF NOT EXISTS project_rosters (
      project_id TEXT PRIMARY KEY,
      tracks_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migration: designs gained org_id for multi-org scoping.
  try {
    db.exec("ALTER TABLE designs ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default'");
  } catch (_e) {
    /* column already exists */
  }

  // Migration: per-design Claude model for Design Studio (null = hub default).
  try {
    db.exec('ALTER TABLE designs ADD COLUMN agent_model TEXT');
  } catch (_e) {
    /* column already exists */
  }

  // Migration: Design Studio engine + resume handle (multi-engine).
  try {
    db.exec('ALTER TABLE designs ADD COLUMN agent_engine TEXT');
  } catch (_e) {
    /* column already exists */
  }
  try {
    db.exec('ALTER TABLE designs ADD COLUMN engine_session_id TEXT');
  } catch (_e) {
    /* column already exists */
  }

  // PR-env subsystem tables were removed by PR-Env Removal #4 along with
  // the PR-env backing directory and the `pr_env_config` row.
  // Drop the tables on existing installs so they don't linger after
  // upgrade; `IF EXISTS` keeps this a no-op on fresh installs. Any
  // encrypted secrets / per-PR data stored in these tables is abandoned
  // with them — the wider epic has already disabled every reader.
  for (const tbl of [
    'pr_env_config',
    'pool_slots',
    'pool_queue',
    'pool_metrics',
    'pool_alerts',
    'pr_env_ports',
    'preview_auth_tokens',
    'preview_auth_sessions',
  ]) {
    try {
      db.exec(`DROP TABLE IF EXISTS ${tbl}`);
    } catch (err) {
      console.warn(`[db] DROP TABLE ${tbl} failed:`, (err as Error).message);
    }
  }

  // Migration: P1 webhook event coalescing CHECK-constraint rebuild.
  // The pr_key / deferred_until / superseded_by columns themselves are added
  // in the pre-bootstrap block above (must run before the bootstrap block's
  // CREATE INDEX on pr_key). What's left here is the conditional table
  // rebuild that updates the `status` CHECK constraint to allow the new
  // 'skipped' value — that requires a full INSERT…SELECT copy and so stays
  // post-bootstrap to run after the table definitively exists.
  {
    const ddl =
      (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='webhook_events'")
          .get() as { sql: string } | undefined
      )?.sql ?? '';
    // Rebuild only when the legacy CHECK set is still in effect AND the new
    // 'skipped' value is missing. Idempotent: subsequent boots find 'skipped'
    // in the DDL and skip the rebuild.
    if (ddl && !ddl.includes("'skipped'")) {
      const handle = db;
      handle.transaction(() => {
        handle.exec(`
          CREATE TABLE webhook_events_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            webhook_config_id INTEGER NOT NULL,
            delivery_id TEXT,
            event_type TEXT NOT NULL,
            action TEXT,
            payload TEXT NOT NULL,
            signature TEXT,
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK(status IN ('pending','processing','done','error','skipped')),
            started_at TEXT,
            completed_at TEXT,
            error_message TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            pr_key TEXT,
            deferred_until TEXT,
            superseded_by INTEGER,
            FOREIGN KEY (webhook_config_id) REFERENCES webhook_configs(id) ON DELETE CASCADE
          );
          INSERT INTO webhook_events_new
            (id, webhook_config_id, delivery_id, event_type, action, payload, signature,
             status, started_at, completed_at, error_message, attempts, created_at,
             pr_key, deferred_until, superseded_by)
          SELECT
            id, webhook_config_id, delivery_id, event_type, action, payload, signature,
            status, started_at, completed_at, error_message, attempts, created_at,
            pr_key, deferred_until, superseded_by
          FROM webhook_events;
          DROP TABLE webhook_events;
          ALTER TABLE webhook_events_new RENAME TO webhook_events;
          CREATE INDEX IF NOT EXISTS idx_webhook_events_status
            ON webhook_events(status, created_at);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_delivery
            ON webhook_events(delivery_id)
            WHERE delivery_id IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_webhook_events_pr_key_active
            ON webhook_events(pr_key, status)
            WHERE pr_key IS NOT NULL AND status IN ('pending','processing');
          CREATE INDEX IF NOT EXISTS idx_webhook_events_deferred
            ON webhook_events(deferred_until)
            WHERE deferred_until IS NOT NULL AND status = 'pending';
        `);
      })();
    }
  }
  // Belt-and-suspenders: if the table was already created with the new CHECK
  // constraint (fresh install or earlier rebuild) the indexes still need to
  // exist on legacy installs that pre-date them.
  try {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_webhook_events_pr_key_active
       ON webhook_events(pr_key, status)
       WHERE pr_key IS NOT NULL AND status IN ('pending','processing')`,
    );
  } catch (_e) {
    /* already exists or column not yet present in this transaction window */
  }
  try {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_webhook_events_deferred
       ON webhook_events(deferred_until)
       WHERE deferred_until IS NOT NULL AND status = 'pending'`,
    );
  } catch (_e) {
    /* already exists */
  }

  // W4 observability migrations on pool_slots / pool_metrics were removed
  // by PR-Env Removal #4 — those tables are now dropped on boot (above).

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages_fts USING fts5(
        title, content, slug UNINDEXED, project_id UNINDEXED,
        content_rowid='rowid'
      );
    `);
  } catch (e: unknown) {
    console.warn('[wiki] FTS5 creation failed (may already exist):', (e as Error).message);
  }

  // Migration: create notes FTS5 index
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        title, content, project_id UNINDEXED,
        content_rowid='rowid'
      );
    `);
  } catch (e: unknown) {
    console.warn('[notes] FTS5 creation failed (may already exist):', (e as Error).message);
  }

  // Wiki embeddings — chunk-level vectors for semantic/hybrid wiki search.
  // One row per (page, chunk_idx). `embedding` is a raw Float32Array BLOB so
  // we can load + cosine-rank in-memory (small N, hundreds of pages). `model`
  // is recorded so we can re-embed when we switch models without churning
  // the schema.
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_embeddings (
      page_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      chunk_idx INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (page_id, chunk_idx)
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_embeddings_project ON wiki_embeddings(project_id);
  `);

  // Workflow builder (MVP): definitions, steps, and execution rows. DDL is
  // shared with workflows-schema.test.ts via workflows-schema.ts.
  db.exec(WORKFLOWS_SCHEMA);

  // Worktree-preview runtime: per-session preview process tracking, owned
  // by `server/preview/preview-runtime.ts`. Schema lives alongside the
  // runtime so the test suite can spin up an in-memory DB without
  // pulling in the full bootstrap path here.
  //
  // Three statements together — legacy single-process table (retained
  // during rollout for downgrade safety), new groups/processes tables,
  // and the one-row migration that folds legacy rows into 1-process
  // groups named `app`. The migration is idempotent (INSERT OR IGNORE)
  // so re-running on a freshly-migrated DB is a no-op.
  db.exec(WORKTREE_PREVIEWS_SCHEMA);
  db.exec(WORKTREE_PREVIEW_GROUPS_SCHEMA);
  db.exec(MIGRATE_LEGACY_PREVIEWS_SQL);

  // Worktree-preview secrets: per-project encrypted env merged into
  // preview spawns. Schema is co-located with `preview-secrets-store.ts`.
  db.exec(WORKTREE_PREVIEW_SECRETS_SCHEMA);

  {
    const wfCols = (db.pragma('table_info(workflows)') as { name: string }[]).map((c) => c.name);
    if (wfCols.length > 0) {
      if (!wfCols.includes('cron_expr')) {
        db.exec('ALTER TABLE workflows ADD COLUMN cron_expr TEXT');
      }
      if (!wfCols.includes('cron_next_run_at')) {
        db.exec('ALTER TABLE workflows ADD COLUMN cron_next_run_at TEXT');
      }
      if (!wfCols.includes('webhook_path_token')) {
        db.exec('ALTER TABLE workflows ADD COLUMN webhook_path_token TEXT');
      }
      if (!wfCols.includes('webhook_signing_secret')) {
        db.exec('ALTER TABLE workflows ADD COLUMN webhook_signing_secret TEXT');
      }
      if (!wfCols.includes('trigger_column_id')) {
        db.exec('ALTER TABLE workflows ADD COLUMN trigger_column_id TEXT');
      }
    }
    try {
      db.exec(WORKFLOWS_WEBHOOK_PATH_INDEX_SQL);
    } catch (e) {
      console.warn('[db] idx_workflows_webhook_token migration:', (e as Error).message);
    }
  }

  {
    const stepCols = (db.pragma('table_info(workflow_steps)') as { name: string }[]).map(
      (c) => c.name,
    );
    if (stepCols.length > 0 && !stepCols.includes('step_project_id')) {
      db.exec('ALTER TABLE workflow_steps ADD COLUMN step_project_id TEXT');
    }
  }

  // Migration: drop the "Backlog" column from every kanban board.
  // Backlog became redundant with "To Do" — every board now starts at
  // To Do. For each board with a Backlog column, move every Backlog
  // card to the bottom of To Do, then delete the empty Backlog column
  // and re-pack remaining column positions. If a board has Backlog
  // but no To Do (unlikely), the column is renamed in place. Idempotent:
  // boards without a Backlog column are skipped on subsequent boots.
  //
  // EXACT-CASE MATCH: this filter is intentionally case-sensitive and
  // requires the literal string "Backlog". Variants like
  // "Project Backlog" or lowercase "backlog" survive untouched —
  // that's the substring back-compat carve-out enforced by
  // `isColumnBlockerSensitive` in `kanban-blockers.ts`. Tests:
  // `server/test/db-backlog-drop-migration.test.ts` (this contract is
  // locked in via the "Project Backlog" Board D case).
  try {
    const backlogCols = db
      .prepare(`SELECT id, board_id FROM kanban_columns WHERE name = 'Backlog'`)
      .all() as { id: string; board_id: string }[];
    if (backlogCols.length > 0) {
      const findToDo = db.prepare(
        `SELECT id FROM kanban_columns WHERE board_id = ? AND name = 'To Do' LIMIT 1`,
      );
      const maxCardPos = db.prepare(
        `SELECT COALESCE(MAX(position), -1) AS p FROM kanban_cards WHERE column_id = ?`,
      );
      const cardsInCol = db.prepare(
        `SELECT id FROM kanban_cards WHERE column_id = ? ORDER BY position ASC`,
      );
      const moveCard = db.prepare(
        `UPDATE kanban_cards SET column_id = ?, position = ?, updated_at = datetime('now') WHERE id = ?`,
      );
      const renameCol = db.prepare(
        `UPDATE kanban_columns SET name = 'To Do', color = '#3B82F6' WHERE id = ?`,
      );
      const deleteCol = db.prepare(`DELETE FROM kanban_columns WHERE id = ?`);
      const colsForBoard = db.prepare(
        `SELECT id FROM kanban_columns WHERE board_id = ? ORDER BY position ASC, name ASC`,
      );
      const setColPos = db.prepare(`UPDATE kanban_columns SET position = ? WHERE id = ?`);
      const txn = db.transaction(() => {
        const touchedBoards = new Set<string>();
        for (const col of backlogCols) {
          touchedBoards.add(col.board_id);
          const todo = findToDo.get(col.board_id) as { id: string } | undefined;
          if (todo) {
            let next = ((maxCardPos.get(todo.id) as { p: number }).p as number) + 1;
            const cards = cardsInCol.all(col.id) as { id: string }[];
            for (const c of cards) {
              moveCard.run(todo.id, next++, c.id);
            }
            deleteCol.run(col.id);
          } else {
            // No To Do column on this board — promote Backlog in place.
            renameCol.run(col.id);
          }
        }
        for (const boardId of touchedBoards) {
          const remaining = colsForBoard.all(boardId) as { id: string }[];
          for (let i = 0; i < remaining.length; i++) {
            setColPos.run(i, remaining[i].id);
          }
        }
      });
      txn();
    }
  } catch (err) {
    // Include the message verbatim — if a constraint trips mid-transaction
    // SQLite surfaces the offending statement which is enough to narrow
    // down which board half-migrated. Boot continues by design: a
    // surviving Backlog column is non-fatal (the rest of the code
    // tolerates it via the substring-match back-compat).
    console.warn(
      '[db] Backlog column drop migration failed (boards may be partially migrated):',
      (err as Error).message,
    );
  }

  const skillCount = db.prepare('SELECT COUNT(*) as count FROM skill_registry').get() as {
    count: number;
  };
  if (skillCount.count === 0) {
    const insertSkill = db.prepare(
      `INSERT INTO skill_registry (id, name, description, category, author, content) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const seedSkills: [string, string, string, string, string, string][] = [
      [
        'code-review',
        'Code Review',
        'Review code for bugs, security issues, and best practices',
        'development',
        'agent-hub',
        '---\nname: code-review\ndescription: Review code for bugs, security issues, and best practices\n---\n\nReview the code changes for:\n- Bugs and logic errors\n- Security vulnerabilities\n- Performance issues\n- Code style and readability\n- Missing error handling\n\nProvide specific, actionable feedback with line references.',
      ],
      [
        'test-generator',
        'Test Generator',
        'Generate unit and integration tests for existing code',
        'development',
        'agent-hub',
        "---\nname: test-generator\ndescription: Generate unit and integration tests for existing code\n---\n\nGenerate comprehensive tests:\n- Unit tests for individual functions\n- Integration tests for API endpoints\n- Edge cases and error scenarios\n- Use the project's existing test framework",
      ],
      [
        'api-docs',
        'API Documentation',
        'Generate OpenAPI/REST documentation from code',
        'documentation',
        'agent-hub',
        '---\nname: api-docs\ndescription: Generate OpenAPI/REST documentation from code\n---\n\nScan the codebase for API endpoints and generate documentation:\n- Endpoint URLs, methods, and descriptions\n- Request/response schemas with examples\n- Authentication requirements\n- Error codes and messages',
      ],
      [
        'changelog',
        'Changelog Generator',
        'Generate changelogs from git history',
        'documentation',
        'agent-hub',
        '---\nname: changelog\ndescription: Generate changelogs from git history\n---\n\nGenerate a changelog from recent git commits:\n- Group by type (features, fixes, breaking changes)\n- Include PR references\n- Write for end users, not developers',
      ],
      [
        'dependency-audit',
        'Dependency Audit',
        'Check for outdated, vulnerable, or unused dependencies',
        'automation',
        'agent-hub',
        '---\nname: dependency-audit\ndescription: Check for outdated, vulnerable, or unused dependencies\n---\n\nAudit project dependencies:\n- Check for known vulnerabilities\n- Identify outdated packages\n- Find unused dependencies\n- Suggest updates with breaking change warnings',
      ],
      [
        'db-migrate',
        'Database Migration',
        'Generate and review database migrations',
        'development',
        'agent-hub',
        '---\nname: db-migrate\ndescription: Generate and review database migrations\n---\n\nHelp with database schema changes:\n- Generate migration files\n- Review migrations for safety (data loss, locking)\n- Verify rollback procedures\n- Check index coverage',
      ],
      [
        'perf-profiler',
        'Performance Profiler',
        'Profile code and identify performance bottlenecks',
        'development',
        'agent-hub',
        '---\nname: perf-profiler\ndescription: Profile code and identify performance bottlenecks\n---\n\nAnalyze code for performance:\n- Identify N+1 queries\n- Find memory leaks\n- Spot unnecessary re-renders\n- Suggest caching strategies\n- Benchmark critical paths',
      ],
      [
        'refactor',
        'Refactor Assistant',
        'Suggest and implement code refactoring improvements',
        'development',
        'agent-hub',
        '---\nname: refactor\ndescription: Suggest and implement code refactoring improvements\n---\n\nAnalyze code for refactoring opportunities:\n- Extract reusable functions/components\n- Simplify complex logic\n- Apply design patterns\n- Reduce duplication\n- Improve naming',
      ],
      [
        'git-hooks',
        'Git Hooks Setup',
        'Configure pre-commit, pre-push, and other git hooks',
        'git',
        'agent-hub',
        '---\nname: git-hooks\ndescription: Configure pre-commit, pre-push, and other git hooks\n---\n\nSet up git hooks for the project:\n- Pre-commit: lint, format, type-check\n- Pre-push: run tests\n- Commit-msg: enforce conventional commits\n- Use husky or simple shell scripts',
      ],
      [
        'env-setup',
        'Environment Setup',
        'Generate and validate environment configuration',
        'automation',
        'agent-hub',
        "---\nname: env-setup\ndescription: Generate and validate environment configuration\n---\n\nHelp with environment setup:\n- Generate .env.example from code references\n- Validate required env vars are set\n- Document each variable's purpose\n- Detect hardcoded secrets",
      ],
      [
        'incident-response',
        'Incident Response',
        'Diagnose production issues from logs and metrics',
        'monitoring',
        'agent-hub',
        '---\nname: incident-response\ndescription: Diagnose production issues from logs and metrics\n---\n\nHelp diagnose production issues:\n- Analyze error logs and stack traces\n- Check recent deployments\n- Identify root cause\n- Suggest immediate fixes\n- Draft incident report',
      ],
      [
        'pr-description',
        'PR Description Writer',
        'Generate detailed PR descriptions from diffs',
        'git',
        'agent-hub',
        '---\nname: pr-description\ndescription: Generate detailed PR descriptions from diffs\n---\n\nGenerate a PR description:\n- Summary of changes\n- Motivation and context\n- Testing instructions\n- Screenshots if UI changes\n- Breaking changes',
      ],
    ];
    for (const [id, name, desc, cat, author, content] of seedSkills) {
      insertSkill.run(id, name, desc, cat, author, content);
    }
  }

  stmts = {
    // Sessions
    createSession: db.prepare(
      'INSERT INTO sessions (id, agent_id, name, engine, model, use_worktree, ask_mode, wiki_hybrid_rag_budget_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    // Live list excludes soft-deleted rows. Callers that need archived rows
    // use `getArchivedSessionsByAgent`. `getSession` stays loose — many code
    // paths (WebSocket, checkpoint lookups, active-process cleanup) legitimately
    // need to look up a row regardless of archive status.
    getSessions: db.prepare(
      'SELECT * FROM sessions WHERE agent_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC',
    ),
    getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    // Used by the awaiting-input snapshot to bound the scan: only sessions a
    // user has plausibly touched in the last week can be "blocked waiting for
    // a reply." The LIMIT keeps the worst-case bootstrap O(few hundred) row
    // reads regardless of long-tail archive churn.
    getRecentLiveSessions: db.prepare(
      `SELECT * FROM sessions
       WHERE deleted_at IS NULL
         AND updated_at >= datetime('now', '-7 days')
       ORDER BY updated_at DESC
       LIMIT 200`,
    ),
    updateSessionName: db.prepare(
      "UPDATE sessions SET name = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionMaxTurns: db.prepare(
      "UPDATE sessions SET max_turns = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    // Soft-delete: mark the row archived. Worktree is intentionally preserved
    // until hard-delete so restore can reattach the same branch/checkout.
    softDeleteSession: db.prepare(
      "UPDATE sessions SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
    ),
    // Restore: clear deleted_at so the session rejoins the live list. Bumps
    // updated_at so the row surfaces at the top of the sidebar after restore.
    restoreArchivedSession: db.prepare(
      "UPDATE sessions SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NOT NULL",
    ),
    // All sessions for an agent regardless of archive status. Used by bulk
    // archive endpoints so already-archived rows can be skipped.
    getAllSessionsByAgent: db.prepare(
      'SELECT * FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC',
    ),
    // Archived sessions within the 24-hour recovery window, newest first.
    // Rows older than a day are excluded so the UI doesn't offer to restore
    // things that are already past the purge horizon; the workspace-purge
    // cron hard-deletes them on its next tick.
    getArchivedSessionsByAgent: db.prepare(
      `SELECT * FROM sessions
       WHERE agent_id = ?
         AND deleted_at IS NOT NULL
         AND deleted_at >= datetime('now', '-1 day')
       ORDER BY deleted_at DESC`,
    ),
    // Sessions whose archive window has expired. The row, the worktree clone,
    // and any FK-cascading children (messages, progress, delegations,
    // handoffs, …) get hard-deleted by the hourly session-purge tick. Mirrors
    // the inverse of `getArchivedSessionsByAgent` (>= -1 day).
    getExpiredArchivedSessions: db.prepare(
      `SELECT id, worktree_path FROM sessions
       WHERE deleted_at IS NOT NULL
         AND deleted_at < datetime('now', '-1 day')`,
    ),
    // Existence probe used by `cleanupStaleWorkspaces` to decide whether a
    // `session-<prefix>` directory on disk has a live or recoverable row.
    // The prefix is the same 8-char slice the workspace dir was named after,
    // so `id LIKE ?||'%'` is a primary-key prefix search. Returns 1 row or
    // none — callers use `.get()`.
    // Newest live reviewer session targeting a particular PR. The bind
    // values are `(reviewer.agent_id, 'Review: PR #<n> %')`; the LIKE
    // pattern is safe because `<n>` is enforced numeric upstream by
    // `parsePrUrl` in `server/routes/pr-actions.ts`. Used by the
    // post-review cleanup hook (`server/reviewer-session-cleanup.ts`) to
    // soft-delete the session and reclaim its worktree clone the moment
    // a formal review lands. Filters `deleted_at IS NULL` so we never
    // clobber an already-archived row, and orders by `created_at DESC`
    // so re-review dispatches resolve to the freshest session.
    getActiveReviewerSessionForPR: db.prepare(
      `SELECT * FROM sessions
       WHERE agent_id = ?
         AND name LIKE ?
         AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    ),
    getRecoverableSessionByIdPrefix: db.prepare(
      `SELECT 1 FROM sessions
       WHERE id LIKE ? || '%'
         AND (deleted_at IS NULL OR deleted_at >= datetime('now', '-1 day'))
       LIMIT 1`,
    ),
    touchSession: db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?"),

    // Sessions - engine & model
    updateSessionEngine: db.prepare(
      "UPDATE sessions SET engine = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionModel: db.prepare(
      "UPDATE sessions SET model = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionEngineSessionId: db.prepare(
      "UPDATE sessions SET engine_session_id = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionPendingSkillContext: db.prepare(
      "UPDATE sessions SET pending_skill_context = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionAutoShipOnComplete: db.prepare(
      "UPDATE sessions SET auto_ship_on_complete = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionWorktree: db.prepare(
      "UPDATE sessions SET use_worktree = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionWorktreePath: db.prepare(
      "UPDATE sessions SET worktree_path = ?, worktree_branch = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    getSessionIdsByWorktreeBranch: db.prepare('SELECT id FROM sessions WHERE worktree_branch = ?'),
    updateSessionGitWorktreeDetected: db.prepare(
      "UPDATE sessions SET git_worktree_detected = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionAskMode: db.prepare(
      "UPDATE sessions SET ask_mode = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionReactLoop: db.prepare(
      "UPDATE sessions SET react_loop_enabled = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionChangesReady: db.prepare(
      "UPDATE sessions SET changes_ready = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionCodeChangedAt: db.prepare(
      "UPDATE sessions SET code_changed_at = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionWikiHybridRagConsumed: db.prepare(
      "UPDATE sessions SET wiki_hybrid_rag_consumed = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionWikiHybridRagBudget: db.prepare(
      "UPDATE sessions SET wiki_hybrid_rag_consumed = ?, wiki_hybrid_rag_budget_version = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionWebSearchCallsUsed: db.prepare(
      "UPDATE sessions SET web_search_calls_used = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionOrchestration: db.prepare(
      "UPDATE sessions SET orchestration_phase = ?, orchestration_meta = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    // Also nulls `stale_pr_notified_at` so a future stale period for the
    // same session re-notifies rather than being permanently suppressed by
    // a prior notification.
    clearSessionChangesReady: db.prepare(
      "UPDATE sessions SET changes_ready = NULL, stale_pr_notified_at = NULL, updated_at = datetime('now') WHERE id = ?",
    ),
    // Sessions that have had pending PR creation for > 30 min and haven't
    // been notified yet. Threshold is baked into the SQL (mirrors the
    // constant in stale-pr-check.ts).
    getStalePendingPrSessions: db.prepare(
      `SELECT id, name, agent_id, changes_ready, updated_at
       FROM sessions
       WHERE changes_ready IS NOT NULL
         AND stale_pr_notified_at IS NULL
         AND updated_at <= datetime('now', '-30 minutes')`,
    ),
    markStalePrNotified: db.prepare(
      "UPDATE sessions SET stale_pr_notified_at = datetime('now') WHERE id = ?",
    ),

    // Background tasks
    insertBackgroundTask: db.prepare(
      `INSERT INTO background_tasks (id, session_id, agent_id, prompt) VALUES (?, ?, ?, ?)`,
    ),
    updateBackgroundTaskStatus: db.prepare(
      `UPDATE background_tasks SET status = ?, completed_at = datetime('now') WHERE id = ?`,
    ),
    getBackgroundTask: db.prepare('SELECT * FROM background_tasks WHERE id = ?'),
    getBackgroundTaskBySession: db.prepare('SELECT * FROM background_tasks WHERE session_id = ?'),
    getBackgroundTasks: db.prepare(
      'SELECT * FROM background_tasks ORDER BY created_at DESC LIMIT ?',
    ),
    getRunningBackgroundTasks: db.prepare(
      `SELECT * FROM background_tasks WHERE status = 'running' ORDER BY created_at DESC`,
    ),

    // Active tasks
    getActiveTask: db.prepare('SELECT * FROM active_tasks WHERE session_id = ?'),
    getAllActiveTasks: db.prepare(
      "SELECT * FROM active_tasks WHERE status = 'running' ORDER BY started_at ASC",
    ),
    insertActiveTask: db.prepare(
      `INSERT INTO active_tasks
        (session_id, message_id, agent_id, pid, prompt, engine, model, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`,
    ),
    updateActiveTaskPid: db.prepare(
      "UPDATE active_tasks SET pid = ?, updated_at = datetime('now') WHERE session_id = ?",
    ),
    appendActiveTaskOutput: db.prepare(
      "UPDATE active_tasks SET streamed_output = ?, updated_at = datetime('now') WHERE session_id = ?",
    ),
    deleteActiveTask: db.prepare('DELETE FROM active_tasks WHERE session_id = ?'),
    deleteAllActiveTasks: db.prepare('DELETE FROM active_tasks'),

    // Messages
    addMessage: db.prepare(
      'INSERT INTO messages (id, session_id, role, content, engine, model, attachments, metadata, agent_id, agent_name, agent_color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    getMessages: db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC'),
    getMessageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
    getLastMessage: db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1',
    ),
    getLastAssistantMessage: db.prepare(
      "SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
    ),

    // Heartbeat logs
    addHeartbeatLog: db.prepare(
      'INSERT INTO heartbeat_logs (agent_id, prompt, status) VALUES (?, ?, ?)',
    ),
    updateHeartbeatLog: db.prepare('UPDATE heartbeat_logs SET result = ?, status = ? WHERE id = ?'),
    getHeartbeatLogs: db.prepare(
      'SELECT * FROM heartbeat_logs WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?',
    ),
    getLatestHeartbeat: db.prepare(
      'SELECT * FROM heartbeat_logs WHERE agent_id = ? ORDER BY timestamp DESC LIMIT 1',
    ),

    // Crons
    getCrons: db.prepare('SELECT * FROM crons ORDER BY id ASC'),
    getCron: db.prepare('SELECT * FROM crons WHERE id = ?'),
    createCron: db.prepare(
      'INSERT INTO crons (name, schedule, prompt, cwd, enabled, project_id, timeout_ms, notify_on_run, model, skill_principal_agent_id, engine) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    updateCron: db.prepare(
      'UPDATE crons SET name = ?, schedule = ?, prompt = ?, cwd = ?, enabled = ?, project_id = ?, timeout_ms = ?, notify_on_run = ?, model = ?, skill_principal_agent_id = ?, engine = ? WHERE id = ?',
    ),
    deleteCron: db.prepare('DELETE FROM crons WHERE id = ?'),
    updateCronResult: db.prepare(
      "UPDATE crons SET last_run = datetime('now'), last_result = ? WHERE id = ?",
    ),
    updateCronNextRun: db.prepare('UPDATE crons SET next_run_at = ? WHERE id = ?'),

    // Cron logs
    addCronLog: db.prepare('INSERT INTO cron_logs (cron_id, status) VALUES (?, ?)'),
    updateCronLog: db.prepare(
      'UPDATE cron_logs SET result = ?, status = ?, duration_ms = ? WHERE id = ?',
    ),
    getCronLogs: db.prepare(
      'SELECT * FROM cron_logs WHERE cron_id = ? ORDER BY timestamp DESC LIMIT ?',
    ),
    pruneCronLogs: db.prepare(
      `DELETE FROM cron_logs WHERE cron_id = ? AND id NOT IN (
         SELECT id FROM cron_logs WHERE cron_id = ? ORDER BY timestamp DESC LIMIT 100
       )`,
    ),

    // Session events (stream-json telemetry for chat/heartbeat/cron runs)
    addSessionEvent: db.prepare(
      `INSERT INTO session_events (parent_kind, parent_id, seq, event_type, payload)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    getSessionEvents: db.prepare(
      `SELECT * FROM session_events
       WHERE parent_kind = ? AND parent_id = ?
       ORDER BY seq ASC`,
    ),
    getSessionEventsForSession: db.prepare(
      `SELECT e.event_type, e.payload
       FROM session_events e
       INNER JOIN messages m ON m.id = e.parent_id
       WHERE e.parent_kind = 'message' AND m.session_id = ?
       ORDER BY m.created_at ASC, e.seq ASC`,
    ),
    countSessionEventsForSession: db.prepare(
      `SELECT COUNT(*) as c
       FROM session_events e
       INNER JOIN messages m ON m.id = e.parent_id
       WHERE e.parent_kind = 'message' AND m.session_id = ?`,
    ),
    deleteSessionEvents: db.prepare(
      'DELETE FROM session_events WHERE parent_kind = ? AND parent_id = ?',
    ),
    countSessionEvents: db.prepare(
      'SELECT COUNT(*) as count FROM session_events WHERE parent_kind = ? AND parent_id = ?',
    ),

    // Session progress steps (Cursor-style ProgressPanel rehydration)
    addSessionProgress: db.prepare(
      `INSERT INTO session_progress (session_id, message_id, step, status, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    // Mark the most recent `started` row for this (session,step) as done.
    // Using the latest id disambiguates when the same step is re-emitted across
    // a session (e.g. re-review) — we only close the most recent open one.
    completeSessionProgress: db.prepare(
      `UPDATE session_progress
         SET status = ?, finished_at = ?
       WHERE id = (
         SELECT id FROM session_progress
         WHERE session_id = ? AND step = ? AND status = 'started'
         ORDER BY id DESC LIMIT 1
       )`,
    ),
    getSessionProgress: db.prepare(
      `SELECT * FROM session_progress
        WHERE session_id = ?
        ORDER BY started_at ASC, id ASC`,
    ),
    deleteSessionProgress: db.prepare('DELETE FROM session_progress WHERE session_id = ?'),

    // Checkpoints (Claude Code auto-save restore points)
    addCheckpoint: db.prepare(
      `INSERT OR IGNORE INTO checkpoints (session_id, message_id, uuid, turn_index, label)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    getCheckpoints: db.prepare(
      `SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at ASC`,
    ),
    getCheckpointByUuid: db.prepare('SELECT * FROM checkpoints WHERE uuid = ?'),
    updateCheckpointLabel: db.prepare('UPDATE checkpoints SET label = ? WHERE uuid = ?'),

    // Heartbeat next-run state (survives server restarts)
    upsertHeartbeatState: db.prepare(
      `INSERT INTO heartbeat_state (agent_id, next_run_at, last_run_at)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         next_run_at = COALESCE(excluded.next_run_at, heartbeat_state.next_run_at),
         last_run_at = COALESCE(excluded.last_run_at, heartbeat_state.last_run_at)`,
    ),
    getHeartbeatState: db.prepare('SELECT * FROM heartbeat_state WHERE agent_id = ?'),
    deleteHeartbeatState: db.prepare('DELETE FROM heartbeat_state WHERE agent_id = ?'),

    // Session advisors (multi-agent sessions)
    getSessionAgents: db.prepare(
      'SELECT * FROM session_agents WHERE session_id = ? ORDER BY position ASC',
    ),
    addSessionAgent: db.prepare(
      `INSERT OR IGNORE INTO session_agents (session_id, agent_id, position)
       VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM session_agents WHERE session_id = ?))`,
    ),
    removeSessionAgent: db.prepare(
      'DELETE FROM session_agents WHERE session_id = ? AND agent_id = ?',
    ),

    // Designs
    listDesigns: db.prepare('SELECT * FROM designs WHERE org_id = ? ORDER BY updated_at DESC'),
    getDesign: db.prepare('SELECT * FROM designs WHERE id = ?'),
    createDesign: db.prepare('INSERT INTO designs (id, name, org_id) VALUES (?, ?, ?)'),
    updateDesignName: db.prepare(
      "UPDATE designs SET name = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateDesignAgentModel: db.prepare(
      "UPDATE designs SET agent_model = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateDesignEngineSessionId: db.prepare(
      "UPDATE designs SET engine_session_id = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateDesignChatEngineModelSession: db.prepare(
      "UPDATE designs SET agent_engine = ?, agent_model = ?, engine_session_id = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    touchDesign: db.prepare("UPDATE designs SET updated_at = datetime('now') WHERE id = ?"),
    deleteDesign: db.prepare('DELETE FROM designs WHERE id = ?'),

    // Design <-> project links
    listDesignProjects: db.prepare(
      'SELECT * FROM design_projects WHERE design_id = ? ORDER BY project_id ASC',
    ),
    linkDesignProject: db.prepare(
      'INSERT OR IGNORE INTO design_projects (design_id, project_id) VALUES (?, ?)',
    ),
    unlinkDesignProject: db.prepare(
      'DELETE FROM design_projects WHERE design_id = ? AND project_id = ?',
    ),
    clearDesignProjects: db.prepare('DELETE FROM design_projects WHERE design_id = ?'),

    // Design messages
    listDesignMessages: db.prepare(
      'SELECT * FROM design_messages WHERE design_id = ? ORDER BY created_at ASC',
    ),
    appendDesignMessage: db.prepare(
      'INSERT INTO design_messages (id, design_id, role, content) VALUES (?, ?, ?, ?)',
    ),

    // Slack messages
    addSlackMessage: db.prepare(
      'INSERT INTO slack_messages (agent_id, channel_id, thread_ts, user_id, user_message, bot_response) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    getSlackMessages: db.prepare(
      'SELECT * FROM slack_messages WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?',
    ),
    getAllSlackMessages: db.prepare('SELECT * FROM slack_messages ORDER BY timestamp DESC LIMIT ?'),

    // Slack bot configs (DB-backed)
    listSlackBots: db.prepare('SELECT * FROM slack_bots ORDER BY created_at ASC'),
    getSlackBot: db.prepare('SELECT * FROM slack_bots WHERE id = ?'),
    insertSlackBot: db.prepare(
      `INSERT INTO slack_bots (id, name, bot_token, app_token, agent_id, channel_map, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateSlackBot: db.prepare(
      `UPDATE slack_bots SET name = ?, bot_token = ?, app_token = ?, agent_id = ?,
       channel_map = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    deleteSlackBot: db.prepare('DELETE FROM slack_bots WHERE id = ?'),
    deleteSlackBotsByAgent: db.prepare('DELETE FROM slack_bots WHERE agent_id = ?'),

    // Delegations
    createDelegation: db.prepare(
      `INSERT INTO delegations (id, session_id, parent_message_id, agent_id, agent_name, task, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    ),
    updateDelegation: db.prepare(
      `UPDATE delegations SET status = ?, output = ?, error = ?, completed_at = datetime('now') WHERE id = ?`,
    ),
    getDelegations: db.prepare(
      'SELECT * FROM delegations WHERE parent_message_id = ? ORDER BY started_at ASC',
    ),
    getDelegationsBySession: db.prepare(
      'SELECT * FROM delegations WHERE session_id = ? ORDER BY started_at DESC',
    ),

    // Handoffs
    createHandoff: db.prepare(
      `INSERT INTO handoffs (id, from_session_id, from_agent_id, to_agent_id, project_id, note, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    ),
    setHandoffToSession: db.prepare(`UPDATE handoffs SET to_session_id = ? WHERE id = ?`),
    markHandoffDelivered: db.prepare(
      `UPDATE handoffs SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?`,
    ),
    markHandoffFailed: db.prepare(`UPDATE handoffs SET status = 'failed', error = ? WHERE id = ?`),
    getHandoffById: db.prepare('SELECT * FROM handoffs WHERE id = ?'),
    getHandoffByToSession: db.prepare(
      'SELECT * FROM handoffs WHERE to_session_id = ? AND status = ? LIMIT 1',
    ),
    getHandoffsFromSession: db.prepare(
      'SELECT * FROM handoffs WHERE from_session_id = ? ORDER BY created_at ASC',
    ),
    insertSkillInvocation: db.prepare(
      `INSERT INTO skill_invocations
       (id, session_id, skill_id, source, reason, status, injected_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    listSkillInvocationsForSession: db.prepare(
      'SELECT * FROM skill_invocations WHERE session_id = ? ORDER BY created_at DESC',
    ),

    // Message queue
    enqueueMessage: db.prepare(
      'INSERT INTO message_queue (id, session_id, agent_id, content, attachments, position) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    getQueuedMessages: db.prepare(
      'SELECT * FROM message_queue WHERE session_id = ? ORDER BY position ASC',
    ),
    getNextQueuedMessage: db.prepare(
      'SELECT * FROM message_queue WHERE session_id = ? ORDER BY position ASC LIMIT 1',
    ),
    dequeueMessage: db.prepare('DELETE FROM message_queue WHERE id = ?'),
    clearSessionQueue: db.prepare('DELETE FROM message_queue WHERE session_id = ?'),
    getMaxQueuePosition: db.prepare(
      'SELECT MAX(position) as max_pos FROM message_queue WHERE session_id = ?',
    ),
    getMinQueuePosition: db.prepare(
      'SELECT MIN(position) as min_pos FROM message_queue WHERE session_id = ?',
    ),
    updateQueueMessage: db.prepare('UPDATE message_queue SET content = ? WHERE id = ?'),
    updateMessageContent: db.prepare('UPDATE messages SET content = ? WHERE id = ?'),
    getAllQueuedSessions: db.prepare('SELECT DISTINCT session_id FROM message_queue'),

    // Cron sessions
    getSessionByCronId: db.prepare('SELECT * FROM sessions WHERE cron_id = ? LIMIT 1'),
    getAllCronSessions: db.prepare(
      `SELECT s.*, c.name as cron_name, c.schedule as cron_schedule
       FROM sessions s JOIN crons c ON s.cron_id = c.id
       ORDER BY s.updated_at DESC`,
    ),
    updateSessionCronId: db.prepare('UPDATE sessions SET cron_id = ? WHERE id = ?'),

    // Thread lookup by source (used by cron/heartbeat to find their thread)
    getThreadBySource: db.prepare(
      'SELECT * FROM threads WHERE project_id = ? AND type = ? AND source_id = ? LIMIT 1',
    ),

    // Device tokens (push notifications)
    registerDeviceToken: db.prepare(
      `INSERT INTO device_tokens (token, platform, user_id, last_used)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(token) DO UPDATE SET
         platform = excluded.platform,
         user_id = excluded.user_id,
         last_used = datetime('now')`,
    ),
    removeDeviceToken: db.prepare('DELETE FROM device_tokens WHERE token = ?'),
    getAllDeviceTokens: db.prepare('SELECT * FROM device_tokens'),
    updateDeviceTokenLastUsed: db.prepare(
      "UPDATE device_tokens SET last_used = datetime('now') WHERE token = ?",
    ),
    getDeviceToken: db.prepare('SELECT * FROM device_tokens WHERE token = ?'),
    setDeviceTokenPreferences: db.prepare(
      'UPDATE device_tokens SET enabled_events = ? WHERE token = ?',
    ),

    // Kanban boards
    getKanbanBoard: db.prepare('SELECT * FROM kanban_boards WHERE project_id = ? LIMIT 1'),
    getKanbanBoardById: db.prepare('SELECT * FROM kanban_boards WHERE id = ?'),
    createKanbanBoard: db.prepare(
      'INSERT INTO kanban_boards (id, project_id, name) VALUES (?, ?, ?)',
    ),
    deleteKanbanBoard: db.prepare('DELETE FROM kanban_boards WHERE id = ?'),

    // Kanban columns
    getKanbanColumn: db.prepare('SELECT * FROM kanban_columns WHERE id = ?'),
    getKanbanColumns: db.prepare(
      'SELECT * FROM kanban_columns WHERE board_id = ? ORDER BY position ASC',
    ),
    createKanbanColumn: db.prepare(
      'INSERT INTO kanban_columns (id, board_id, name, position, color) VALUES (?, ?, ?, ?, ?)',
    ),
    updateKanbanColumn: db.prepare(
      'UPDATE kanban_columns SET name = ?, position = ?, color = ? WHERE id = ?',
    ),
    deleteKanbanColumn: db.prepare('DELETE FROM kanban_columns WHERE id = ?'),

    // Kanban cards
    getKanbanCards: db.prepare(
      'SELECT * FROM kanban_cards WHERE board_id = ? ORDER BY position ASC',
    ),
    getKanbanCardsByColumn: db.prepare(
      'SELECT * FROM kanban_cards WHERE column_id = ? ORDER BY position ASC',
    ),
    getKanbanCard: db.prepare('SELECT * FROM kanban_cards WHERE id = ?'),
    createKanbanCard: db.prepare(
      `INSERT INTO kanban_cards (id, column_id, board_id, title, description, priority, assignee, labels, session_id, github_issue_url, created_by, assign_model, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateKanbanCard: db.prepare(
      `UPDATE kanban_cards SET title = ?, description = ?, priority = ?, assignee = ?, labels = ?, session_id = ?, github_issue_url = ?, pr_url = ?, epic_id = ?, assign_model = ?, assign_engine = ?, pr_base_branch = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    moveKanbanCard: db.prepare(
      `UPDATE kanban_cards SET column_id = ?, position = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    setCardPrUrl: db.prepare(
      "UPDATE kanban_cards SET pr_url = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    setCardLastDispatchedReviewId: db.prepare(
      "UPDATE kanban_cards SET last_dispatched_review_id = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    setCardLastDispatchedCheckRunId: db.prepare(
      "UPDATE kanban_cards SET last_dispatched_check_run_id = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    setCardLastDispatchedReviewCommentId: db.prepare(
      "UPDATE kanban_cards SET last_dispatched_review_comment_id = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    // Atomically bump autofix_dispatch_count and return the new value via
    // RETURNING. `better-sqlite3` supports RETURNING on UPDATE since v9, so a
    // single round-trip serves the increment + read.
    bumpCardAutofixDispatchCount: db.prepare(
      `UPDATE kanban_cards
         SET autofix_dispatch_count = autofix_dispatch_count + 1,
             updated_at = datetime('now')
       WHERE id = ?
   RETURNING autofix_dispatch_count`,
    ),
    getCardAutofixDispatchCount: db.prepare(
      'SELECT autofix_dispatch_count FROM kanban_cards WHERE id = ?',
    ),
    // Used by <handoff> delivery to re-point a card from the source session
    // to the newly-created target session and update the assignee to the
    // specialist taking over. Scoped to just these two fields so a handoff
    // can't accidentally clobber title/description/labels/etc.
    reassignCardToSession: db.prepare(
      "UPDATE kanban_cards SET session_id = ?, assignee = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    getKanbanCardBySession: db.prepare('SELECT * FROM kanban_cards WHERE session_id = ? LIMIT 1'),
    getKanbanCardByPrUrl: db.prepare('SELECT * FROM kanban_cards WHERE pr_url = ? LIMIT 1'),
    // Feeds `server/pr-rebase-poll.ts`. We hard-code the 15-minute window
    // here (matches `PR_REBASE_STALE_AGE_MS` in pre-push-rebase). The
    // sessions LEFT JOIN tolerates cards whose creator session row was
    // garbage-collected — `session_agent_id` is null in that case and the
    // poller skips the row.
    getStalePrCardsForRebaseCheck: db.prepare(
      `SELECT
         c.id            AS card_id,
         c.title         AS card_title,
         b.project_id    AS project_id,
         c.pr_url        AS pr_url,
         c.updated_at    AS card_updated_at,
         s.agent_id      AS session_agent_id
       FROM kanban_cards c
       JOIN kanban_columns col ON c.column_id = col.id
       JOIN kanban_boards b ON c.board_id = b.id
       LEFT JOIN sessions s ON c.session_id = s.id
       WHERE c.pr_url IS NOT NULL
         AND col.name = 'Review'
         AND datetime(c.updated_at) < datetime('now', '-15 minutes')
       ORDER BY c.updated_at ASC
       LIMIT 50`,
    ),
    getNextUndocumentedCard: db.prepare(
      `SELECT c.*, col.name as column_name FROM kanban_cards c
       JOIN kanban_columns col ON c.column_id = col.id
       WHERE c.board_id = ? AND col.name = 'Done' AND c.documented = 0
       ORDER BY c.updated_at ASC LIMIT 1`,
    ),
    markCardDocumented: db.prepare(
      "UPDATE kanban_cards SET documented = 1, updated_at = datetime('now') WHERE id = ?",
    ),
    deleteKanbanCard: db.prepare('DELETE FROM kanban_cards WHERE id = ?'),

    // Kanban card comments
    getKanbanCardComments: db.prepare(
      'SELECT * FROM kanban_card_comments WHERE card_id = ? ORDER BY created_at ASC',
    ),
    createKanbanCardComment: db.prepare(
      'INSERT INTO kanban_card_comments (id, card_id, author, content) VALUES (?, ?, ?, ?)',
    ),
    deleteKanbanCardComment: db.prepare('DELETE FROM kanban_card_comments WHERE id = ?'),

    // Card blockers (see server/kanban-blockers.ts for helpers).
    // getBlockersForBoard is the single-query enrichment used by GET /board —
    // joining blocker rows with both the blocker card and its column lets the
    // route annotate every card without N+1 lookups. Returned columns are
    // explicit rather than `SELECT *` because we need both sides of the edge.
    getBlockersForBoard: db.prepare(
      `SELECT b.card_id AS card_id,
              b.blocked_by_card_id AS blocked_by_card_id,
              blocker.id AS blocker_id,
              blocker.title AS blocker_title,
              blocker.column_id AS blocker_column_id,
              blocker_col.name AS blocker_column_name,
              blocked.id AS blocked_id,
              blocked.title AS blocked_title,
              blocked.column_id AS blocked_column_id,
              blocked_col.name AS blocked_column_name
       FROM kanban_card_blockers b
       JOIN kanban_cards blocker ON b.blocked_by_card_id = blocker.id
       JOIN kanban_columns blocker_col ON blocker.column_id = blocker_col.id
       JOIN kanban_cards blocked ON b.card_id = blocked.id
       JOIN kanban_columns blocked_col ON blocked.column_id = blocked_col.id
       WHERE blocker.board_id = ?`,
    ),
    getBlockersForCard: db.prepare(
      'SELECT blocked_by_card_id FROM kanban_card_blockers WHERE card_id = ?',
    ),
    getBlocker: db.prepare(
      'SELECT * FROM kanban_card_blockers WHERE card_id = ? AND blocked_by_card_id = ?',
    ),
    createBlocker: db.prepare(
      'INSERT INTO kanban_card_blockers (id, card_id, blocked_by_card_id) VALUES (?, ?, ?)',
    ),
    deleteBlocker: db.prepare(
      'DELETE FROM kanban_card_blockers WHERE card_id = ? AND blocked_by_card_id = ?',
    ),

    // Review logs
    createReviewLog: db.prepare(
      `INSERT INTO review_logs (id, project_id, card_id, pr_url, reviewer_agent, author_agent, session_id, outcome, review_body, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getReviewLogs: db.prepare(
      'SELECT * FROM review_logs WHERE project_id = ? ORDER BY completed_at DESC LIMIT ?',
    ),
    getReviewLogsByCard: db.prepare(
      'SELECT * FROM review_logs WHERE card_id = ? ORDER BY completed_at DESC',
    ),
    getReviewLogsByPrUrl: db.prepare(
      'SELECT * FROM review_logs WHERE pr_url = ? ORDER BY completed_at DESC',
    ),

    createPrCreationLog: db.prepare(
      `INSERT OR IGNORE INTO pr_creation_logs (id, project_id, card_id, session_id, pr_url, pr_number, pr_title, author_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getPrCreationLogsByProject: db.prepare(
      'SELECT * FROM pr_creation_logs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
    ),

    // pr_state — per-PR reviewer/check-run tracking
    //
    // started_at is stored as ISO 8601 with explicit `Z` so that JS
    // `new Date(row.started_at).getTime()` parses it as UTC on every host.
    // SQLite's `datetime('now')` returns `YYYY-MM-DD HH:MM:SS` (no `T`, no `Z`),
    // which V8 treats as LOCAL time — that's how prior runs computed wrong
    // elapsed values on non-UTC machines. The strftime form fixes that.
    //
    // Note the `started_at` clause in the UPDATE branch: we ONLY rebase the
    // baseline when this is a brand-new commit (different head_sha). Repeated
    // upserts during the same dispatch (e.g. seed → attach check_run_id)
    // preserve the original baseline so per-phase elapsed math stays honest.
    upsertPrState: db.prepare(
      `INSERT INTO pr_state (id, project_id, repo_full_name, pr_number, head_sha, check_run_id, status, phase, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(repo_full_name, pr_number) DO UPDATE SET
         project_id = excluded.project_id,
         head_sha = excluded.head_sha,
         check_run_id = excluded.check_run_id,
         status = excluded.status,
         phase = excluded.phase,
         started_at = CASE
           WHEN excluded.head_sha IS NOT pr_state.head_sha
             THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           ELSE pr_state.started_at
         END,
         completed_at = CASE
           WHEN excluded.head_sha IS NOT pr_state.head_sha THEN NULL
           ELSE pr_state.completed_at
         END,
         conclusion = CASE
           WHEN excluded.head_sha IS NOT pr_state.head_sha THEN NULL
           ELSE pr_state.conclusion
         END,
         updated_at = datetime('now')`,
    ),
    updatePrStatePhase: db.prepare(
      `UPDATE pr_state SET phase = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    /**
     * Attach the GitHub Check Run id after the POST /check-runs call lands.
     * Distinct from `upsertPrState` so the second write of an `ensureCheckRunForPR`
     * dispatch does NOT touch `started_at` (which would skew elapsed timing).
     */
    attachCheckRunId: db.prepare(
      `UPDATE pr_state SET check_run_id = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    completePrState: db.prepare(
      `UPDATE pr_state SET status = 'completed', conclusion = ?, phase = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ),
    /** Cleanup hook: PR closed/merged → drop the row. Bounded already by the
     * unique (repo_full_name, pr_number) index, but keeps the table tidy. */
    deletePrStateByRepoPr: db.prepare(
      'DELETE FROM pr_state WHERE repo_full_name = ? AND pr_number = ?',
    ),
    getPrState: db.prepare('SELECT * FROM pr_state WHERE id = ?'),
    getPrStateByRepoPr: db.prepare(
      'SELECT * FROM pr_state WHERE repo_full_name = ? AND pr_number = ?',
    ),
    getPrStateByCheckRunId: db.prepare('SELECT * FROM pr_state WHERE check_run_id = ?'),

    // Card review status
    setCardReviewStatus: db.prepare(
      "UPDATE kanban_cards SET review_status = ?, updated_at = datetime('now') WHERE id = ?",
    ),

    // Kanban epics
    getKanbanEpics: db.prepare(
      'SELECT * FROM kanban_epics WHERE board_id = ? ORDER BY position ASC',
    ),
    getKanbanEpic: db.prepare('SELECT * FROM kanban_epics WHERE id = ?'),
    createKanbanEpic: db.prepare(
      `INSERT INTO kanban_epics (id, board_id, name, description, color, position) VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    updateKanbanEpic: db.prepare(
      `UPDATE kanban_epics SET name = ?, description = ?, color = ?, autonomous = ?, autonomous_interval = ?, autonomous_max_concurrent = ?, autonomous_model = ?, orchestration_budgets_json = ?, pr_base_branch = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    // Standalone stamp for the user who flipped autonomous mode on. Kept
    // separate from updateKanbanEpic so existing call sites (and the
    // public PUT /epics/:id payload) don't have to thread an extra arg.
    setEpicAutonomousEnabledBy: db.prepare(
      `UPDATE kanban_epics SET autonomous_enabled_by = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    deleteKanbanEpic: db.prepare('DELETE FROM kanban_epics WHERE id = ?'),
    getKanbanCardsByEpic: db.prepare(
      'SELECT * FROM kanban_cards WHERE epic_id = ? ORDER BY position ASC',
    ),
    updateKanbanCardEpic: db.prepare(
      "UPDATE kanban_cards SET epic_id = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    getAutonomousEpic: db.prepare(
      'SELECT * FROM kanban_epics WHERE board_id = ? AND autonomous = 1 LIMIT 1',
    ),
    getEligibleAutonomousCards: db.prepare(
      // Autonomous dispatch pulls from the 'To Do' column (Backlog was
      // dropped in May 2026). Within the column we sort by `priority`
      // (urgent → high → medium → low → unset) and then by `position` ASC
      // (the visual top of the column) as the tiebreaker — higher-priority
      // work drains first. A card is dispatchable when it sits in To Do
      // and has no assignee; the autonomous loop no longer caps how many
      // times the same card may be re-dispatched (operators are expected
      // to move stuck cards out of To Do manually).
      `SELECT c.* FROM kanban_cards c
       JOIN kanban_columns col ON c.column_id = col.id
       WHERE c.epic_id = ? AND col.name = 'To Do'
       AND (c.assignee IS NULL OR c.assignee = '')
       ORDER BY
         CASE c.priority
           WHEN 'urgent' THEN 0
           WHEN 'high' THEN 1
           WHEN 'medium' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         c.position ASC`,
    ),
    markCardDispatchedByAutonomous: db.prepare(
      `UPDATE kanban_cards SET dispatched_by_autonomous = 1, updated_at = datetime('now') WHERE id = ?`,
    ),

    // NOTE: The legacy triage gate (setCardTriage / clearCardTriage /
    // getUntriagedAutonomousCards / getInFlightTriageCards) was removed
    // when autonomous dispatch switched to label-based routing. The
    // `triaged_at`, `triaged_by`, and `suggested_assignee` columns remain
    // on `kanban_cards` for backward-compat with existing rows, but the
    // dispatch path no longer reads or writes them. See server/routing.ts.

    // Webhook configs
    getWebhookConfigs: db.prepare('SELECT * FROM webhook_configs ORDER BY created_at DESC'),
    getWebhookConfigsByProject: db.prepare(
      'SELECT * FROM webhook_configs WHERE project_id = ? ORDER BY created_at DESC',
    ),
    getWebhookConfig: db.prepare('SELECT * FROM webhook_configs WHERE id = ?'),
    createWebhookConfig: db.prepare(
      'INSERT INTO webhook_configs (project_id, repo_url, secret, events, enabled, author_allowlist) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    updateWebhookConfig: db.prepare(
      "UPDATE webhook_configs SET repo_url = ?, events = ?, enabled = ?, author_allowlist = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    deleteWebhookConfig: db.prepare('DELETE FROM webhook_configs WHERE id = ?'),
    getWebhookConfigByProjectAndRepo: db.prepare(
      'SELECT * FROM webhook_configs WHERE project_id = ? AND repo_url = ?',
    ),
    addWebhookLog: db.prepare(
      'INSERT INTO webhook_logs (webhook_config_id, event_type, action, delivery_id, status) VALUES (?, ?, ?, ?, ?)',
    ),
    updateWebhookLog: db.prepare(
      'UPDATE webhook_logs SET status = ?, result = ?, duration_ms = ? WHERE id = ?',
    ),
    getWebhookLogs: db.prepare(
      'SELECT * FROM webhook_logs WHERE webhook_config_id = ? ORDER BY created_at DESC LIMIT ?',
    ),
    getRecentWebhookLogs: db.prepare(
      'SELECT wl.*, wc.repo_url FROM webhook_logs wl JOIN webhook_configs wc ON wl.webhook_config_id = wc.id ORDER BY wl.created_at DESC LIMIT ?',
    ),

    // Webhook events queue (fast-ack + background worker)
    insertWebhookEvent: db.prepare(
      `INSERT INTO webhook_events
         (webhook_config_id, delivery_id, event_type, action, payload, signature, pr_key, deferred_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getWebhookEventByDelivery: db.prepare(
      'SELECT id FROM webhook_events WHERE delivery_id = ? LIMIT 1',
    ),
    getWebhookEventById: db.prepare('SELECT * FROM webhook_events WHERE id = ?'),
    // Atomic claim: picks the oldest eligible pending row and flips it to
    // 'processing' in a single UPDATE, returning the row. Safe under WAL
    // because better-sqlite3 is single-threaded per connection — no other
    // writer can interleave inside this statement.
    //
    // P1 contract (card 2c4a0d06):
    //   * deferred_until — skip rows whose persistent debounce window
    //     hasn't elapsed yet. Replaces the in-memory reviewerDebounceTimers.
    //   * pr_key NOT IN (… processing …) — never claim two rows for the
    //     same PR concurrently. The webhook handler may dispatch git ops
    //     against the PR worktree; serializing per-PR is what keeps a
    //     reviewer race or autofix race from clobbering itself.
    claimPendingWebhookEvent: db.prepare(`
      UPDATE webhook_events
      SET status = 'processing',
          started_at = datetime('now'),
          attempts = attempts + 1
      WHERE id = (
        SELECT id FROM webhook_events e1
        WHERE e1.status = 'pending'
          AND (e1.deferred_until IS NULL OR e1.deferred_until <= datetime('now'))
          AND (
            e1.pr_key IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM webhook_events e2
              WHERE e2.status = 'processing'
                AND e2.pr_key IS NOT NULL
                AND e2.pr_key = e1.pr_key
            )
          )
        ORDER BY e1.created_at ASC, e1.id ASC
        LIMIT 1
      )
      RETURNING *
    `),
    markWebhookEventDone: db.prepare(
      "UPDATE webhook_events SET status = 'done', completed_at = datetime('now') WHERE id = ?",
    ),
    markWebhookEventError: db.prepare(
      "UPDATE webhook_events SET status = 'error', completed_at = datetime('now'), error_message = ? WHERE id = ?",
    ),
    // Stale-claim recovery: reset rows stuck in 'processing' back to 'pending'
    // on server boot. Safe because the worker hasn't started yet.
    resetStaleWebhookEvents: db.prepare(
      "UPDATE webhook_events SET status = 'pending', started_at = NULL WHERE status = 'processing'",
    ),
    countWebhookEventsByStatus: db.prepare(
      'SELECT status, COUNT(*) AS n FROM webhook_events GROUP BY status',
    ),
    // Insert-time coalescing: when a new row arrives with non-null pr_key,
    // mark every OLDER pending row sharing (event_type, action, pr_key) as
    // 'skipped' with `superseded_by` pointing at the new row. Run inside the
    // same insert path so the worker's claim query stays a single atomic
    // UPDATE — there's no separate sweep tick to lose races against.
    //
    // Bound parameters:
    //   1. superseded_by id (the newer row's id)
    //   2. event_type
    //   3. action (NULL-safe via IS, see action-or-null treatment below)
    //   4. pr_key
    //   5. id of the new row (so we don't supersede ourselves)
    //
    // `action IS ?` is intentional — synchronize/opened/closed all live
    // under event_type='pull_request' with distinct `action` values. We
    // coalesce within the same action (so a synchronize doesn't supersede
    // a closed event for the same PR).
    coalescePendingForKey: db.prepare(`
      UPDATE webhook_events
      SET status = 'skipped',
          completed_at = datetime('now'),
          superseded_by = ?
      WHERE status = 'pending'
        AND event_type = ?
        AND action IS ?
        AND pr_key = ?
        AND id != ?
    `),
    countPendingForPrKey: db.prepare(
      "SELECT COUNT(*) AS n FROM webhook_events WHERE pr_key = ? AND status IN ('pending','processing')",
    ),
    // Used by isReviewerDispatchPending: returns 1 if any pending row exists
    // for this pr_key whose deferred_until is still in the future (or whose
    // event_type is one of the reviewer-triggering kinds and is still
    // pending). Exact match on pr_key — caller passes `<repo>:<prNumber>`.
    hasDeferredPendingForPrKey: db.prepare(`
      SELECT 1 AS found
      FROM webhook_events
      WHERE pr_key = ?
        AND status = 'pending'
        AND event_type = 'pull_request'
        AND action IN ('opened','synchronize')
      LIMIT 1
    `),
    // Evaluate a SQLite datetime modifier string (e.g. '+30 seconds') against
    // 'now' under the DB clock. Used by the webhook enqueue path so the
    // resulting `deferred_until` value is comparable to the worker's
    // `claimPendingWebhookEvent` predicate (which uses `datetime('now')`).
    // Pulled out as a prepared statement to keep the SQLite expression on the
    // DB side (no JS Date math) and to make the eval cacheable.
    evalDatetimeOffset: db.prepare("SELECT datetime('now', ?) AS ts"),

    // Wiki pages
    getWikiPages: db.prepare(
      'SELECT id, project_id, title, slug, category, updated_by, created_at, updated_at FROM wiki_pages WHERE project_id = ? ORDER BY updated_at DESC',
    ),
    getWikiPage: db.prepare('SELECT * FROM wiki_pages WHERE project_id = ? AND slug = ?'),
    getWikiPageById: db.prepare('SELECT * FROM wiki_pages WHERE id = ?'),
    createWikiPage: db.prepare(
      'INSERT INTO wiki_pages (id, project_id, title, slug, content, category, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    updateWikiPage: db.prepare(
      "UPDATE wiki_pages SET title = ?, content = ?, category = ?, updated_by = ?, updated_at = datetime('now') WHERE project_id = ? AND slug = ?",
    ),
    deleteWikiPage: db.prepare('DELETE FROM wiki_pages WHERE project_id = ? AND slug = ?'),
    getWikiPagesByCategory: db.prepare(
      'SELECT id, project_id, title, slug, category, updated_by, created_at, updated_at FROM wiki_pages WHERE project_id = ? AND category = ? ORDER BY updated_at DESC',
    ),

    // Wiki embeddings
    getWikiEmbeddingsByProject: db.prepare(
      'SELECT page_id, chunk_idx, chunk_text, embedding, model FROM wiki_embeddings WHERE project_id = ?',
    ),
    getWikiEmbeddingsByPage: db.prepare(
      'SELECT page_id, chunk_idx, chunk_text, embedding, model FROM wiki_embeddings WHERE page_id = ? ORDER BY chunk_idx ASC',
    ),
    deleteWikiEmbeddingsByPage: db.prepare('DELETE FROM wiki_embeddings WHERE page_id = ?'),
    upsertWikiEmbedding: db.prepare(
      `INSERT INTO wiki_embeddings (page_id, project_id, chunk_idx, chunk_text, embedding, model)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(page_id, chunk_idx) DO UPDATE SET
         chunk_text = excluded.chunk_text,
         embedding = excluded.embedding,
         model = excluded.model,
         created_at = datetime('now')`,
    ),
    countWikiEmbeddingsByPage: db.prepare(
      'SELECT COUNT(*) as n FROM wiki_embeddings WHERE page_id = ?',
    ),

    // Threads
    getThreadsByProject: db.prepare(
      'SELECT * FROM threads WHERE project_id = ? ORDER BY created_at DESC',
    ),
    getThreadsByProjectAndType: db.prepare(
      'SELECT * FROM threads WHERE project_id = ? AND type = ? ORDER BY created_at DESC',
    ),
    getThread: db.prepare('SELECT * FROM threads WHERE id = ?'),
    getThreadBySourceId: db.prepare(
      'SELECT * FROM threads WHERE project_id = ? AND type = ? AND source_id = ?',
    ),
    createThread: db.prepare(
      'INSERT INTO threads (id, project_id, name, type, source_id) VALUES (?, ?, ?, ?, ?)',
    ),
    deleteThread: db.prepare('DELETE FROM threads WHERE id = ?'),

    // Thread entries
    getThreadEntries: db.prepare(
      'SELECT * FROM thread_entries WHERE thread_id = ? ORDER BY timestamp ASC',
    ),
    getThreadEntry: db.prepare('SELECT * FROM thread_entries WHERE id = ?'),
    createThreadEntry: db.prepare(
      'INSERT INTO thread_entries (id, thread_id, content) VALUES (?, ?, ?)',
    ),
    // Human-authored entry — `POST /api/threads/:threadId/entries`. Stamps
    // role='user' and (optionally) the user id resolved by the auth
    // middleware. Daemons keep using the 3-arg `createThreadEntry` above,
    // which falls back to the column DEFAULT of 'system' for role.
    createUserThreadEntry: db.prepare(
      "INSERT INTO thread_entries (id, thread_id, content, author_user_id, role) VALUES (?, ?, ?, ?, 'user')",
    ),
    deleteThreadEntry: db.prepare('DELETE FROM thread_entries WHERE id = ?'),
    deleteThreadEntries: db.prepare('DELETE FROM thread_entries WHERE thread_id = ?'),
    pruneThreadEntries: db.prepare(
      `DELETE FROM thread_entries WHERE thread_id = ? AND id NOT IN (
         SELECT id FROM thread_entries WHERE thread_id = ? ORDER BY timestamp DESC LIMIT 100
       )`,
    ),

    // Skill registry
    getSkillRegistry: db.prepare(
      'SELECT * FROM skill_registry ORDER BY install_count DESC, name ASC',
    ),
    getSkillRegistryByCategory: db.prepare(
      'SELECT * FROM skill_registry WHERE category = ? ORDER BY install_count DESC, name ASC',
    ),
    getSkillRegistryItem: db.prepare('SELECT * FROM skill_registry WHERE id = ?'),
    searchSkillRegistry: db.prepare(
      'SELECT * FROM skill_registry WHERE name LIKE ? OR description LIKE ? ORDER BY install_count DESC',
    ),
    createSkillRegistryItem: db.prepare(
      `INSERT INTO skill_registry (id, name, description, category, author, source_url, repo_url, version, content)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    deleteSkillRegistryItem: db.prepare('DELETE FROM skill_registry WHERE id = ?'),
    incrementSkillInstallCount: db.prepare(
      'UPDATE skill_registry SET install_count = install_count + 1 WHERE id = ?',
    ),
    getSkillRegistryCount: db.prepare('SELECT COUNT(*) as count FROM skill_registry'),

    // Agent skill overrides
    getAgentSkillOverrides: db.prepare('SELECT * FROM agent_skill_overrides WHERE agent_id = ?'),
    upsertAgentSkillOverride: db.prepare(
      `INSERT INTO agent_skill_overrides (agent_id, skill_id, enabled) VALUES (?, ?, ?)
       ON CONFLICT(agent_id, skill_id) DO UPDATE SET enabled = excluded.enabled`,
    ),
    deleteAgentSkillOverride: db.prepare(
      'DELETE FROM agent_skill_overrides WHERE agent_id = ? AND skill_id = ?',
    ),

    // Escalations
    getEscalationsByProject: db.prepare(
      'SELECT * FROM escalations WHERE project_id = ? ORDER BY created_at DESC',
    ),
    getActiveEscalationsByProject: db.prepare(
      'SELECT * FROM escalations WHERE project_id = ? AND acknowledged = 0 ORDER BY created_at DESC',
    ),
    getAllActiveEscalations: db.prepare(
      'SELECT * FROM escalations WHERE acknowledged = 0 ORDER BY created_at DESC',
    ),
    getEscalation: db.prepare('SELECT * FROM escalations WHERE id = ?'),
    createEscalation: db.prepare(
      `INSERT INTO escalations (id, project_id, type, title, description, pr_number, pr_url, card_id, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    acknowledgeEscalation: db.prepare('UPDATE escalations SET acknowledged = 1 WHERE id = ?'),
    deleteEscalation: db.prepare('DELETE FROM escalations WHERE id = ?'),
    deleteEscalationsByProject: db.prepare('DELETE FROM escalations WHERE project_id = ?'),

    // Workflows
    getWorkflowsByProject: db.prepare(
      'SELECT * FROM workflows WHERE project_id = ? ORDER BY name ASC, created_at ASC',
    ),
    getWorkflow: db.prepare('SELECT * FROM workflows WHERE id = ?'),
    createWorkflow: db.prepare(
      `INSERT INTO workflows (id, project_id, name, trigger_type, default_payload, cron_expr, cron_next_run_at, webhook_path_token, webhook_signing_secret, trigger_column_id)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ),
    updateWorkflow: db.prepare(
      `UPDATE workflows SET name = ?, trigger_type = ?, default_payload = ?, cron_expr = ?, webhook_path_token = ?, webhook_signing_secret = ?, trigger_column_id = ?, updated_at = datetime('now')
       WHERE id = ? AND project_id = ?`,
    ),
    updateWorkflowCronNextRun: db.prepare(
      `UPDATE workflows SET cron_next_run_at = ? WHERE id = ? AND project_id = ?`,
    ),
    updateWorkflowWebhookSecret: db.prepare(
      `UPDATE workflows SET webhook_signing_secret = ?, updated_at = datetime('now') WHERE id = ? AND project_id = ?`,
    ),
    getWorkflowByWebhookToken: db.prepare(
      'SELECT * FROM workflows WHERE webhook_path_token = ? LIMIT 1',
    ),
    getWorkflowsWithCronExpr: db.prepare(
      `SELECT * FROM workflows WHERE cron_expr IS NOT NULL AND length(trim(cron_expr)) > 0`,
    ),
    getWorkflowsByKanbanTriggerColumn: db.prepare(
      `SELECT * FROM workflows WHERE project_id = ? AND trigger_column_id = ?`,
    ),
    deleteWorkflow: db.prepare('DELETE FROM workflows WHERE id = ? AND project_id = ?'),
    getWorkflowSteps: db.prepare(
      'SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order ASC, id ASC',
    ),
    getWorkflowStepsByProject: db.prepare(
      `SELECT s.* FROM workflow_steps s
       INNER JOIN workflows w ON s.workflow_id = w.id
       WHERE w.project_id = ?
       ORDER BY s.workflow_id, s.step_order ASC, s.id ASC`,
    ),
    deleteWorkflowStepsByWorkflow: db.prepare('DELETE FROM workflow_steps WHERE workflow_id = ?'),
    createWorkflowStep: db.prepare(
      `INSERT INTO workflow_steps
        (id, workflow_id, agent_id, title, role_prompt, step_order, timeout_ms, on_failure, condition_expr, parallel_group, step_project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    createWorkflowRun: db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, status, run_payload) VALUES (?, ?, ?, ?)`,
    ),
    getWorkflowRun: db.prepare('SELECT * FROM workflow_runs WHERE id = ?'),
    getWorkflowRunsLimited: db.prepare(
      'SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?',
    ),
    updateWorkflowRunToRunning: db.prepare(
      `UPDATE workflow_runs SET status = 'running', updated_at = datetime('now') WHERE id = ?`,
    ),
    updateWorkflowRunTerminal: db.prepare(
      `UPDATE workflow_runs SET status = ?, error = ?, completed_at = datetime('now'),
       updated_at = datetime('now') WHERE id = ?`,
    ),
    createWorkflowStepRunStart: db.prepare(
      `INSERT INTO workflow_step_runs (id, workflow_run_id, workflow_step_id, status, started_at)
       VALUES (?, ?, ?, 'running', datetime('now'))`,
    ),
    updateWorkflowStepRunComplete: db.prepare(
      `UPDATE workflow_step_runs SET status = ?, output = ?, error = ?,
        completed_at = datetime('now') WHERE id = ?`,
    ),
    resetWorkflowStepRunForRetry: db.prepare(
      `UPDATE workflow_step_runs SET status = 'running', output = NULL, error = NULL,
        started_at = datetime('now'), completed_at = NULL WHERE id = ?`,
    ),
    failStuckRunningWorkflowRuns: db.prepare(
      `UPDATE workflow_runs
       SET status = 'error', error = 'Workflow run interrupted (server restart or crash)',
           completed_at = datetime('now'), updated_at = datetime('now')
       WHERE status = 'running'`,
    ),
    failStuckRunningWorkflowStepRuns: db.prepare(
      `UPDATE workflow_step_runs
       SET status = 'error', error = 'Step run interrupted (server restart or crash)',
           completed_at = datetime('now')
       WHERE status = 'running'`,
    ),
    getWorkflowStepRun: db.prepare('SELECT * FROM workflow_step_runs WHERE id = ?'),
    getWorkflowRunScoped: db.prepare(
      `SELECT r.* FROM workflow_runs r
       INNER JOIN workflows w ON w.id = r.workflow_id AND w.project_id = ?
       WHERE r.id = ? AND r.workflow_id = ?`,
    ),
    cancelWorkflowRunIfPending: db.prepare(
      `UPDATE workflow_runs
       SET status = 'cancelled', error = ?, completed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND workflow_id = ? AND status = 'pending'`,
    ),
    getWorkflowStepRunsForRun: db.prepare(
      `SELECT sr.*, st.title AS step_title, st.step_order AS step_def_order
       FROM workflow_step_runs sr
       LEFT JOIN workflow_steps st ON st.id = sr.workflow_step_id
       WHERE sr.workflow_run_id = ?
       ORDER BY COALESCE(st.step_order, 999999) ASC, sr.id ASC`,
    ),

    // Notes
    getNotes: db.prepare(
      'SELECT id, project_id, title, created_at, updated_at FROM notes WHERE project_id = ? ORDER BY updated_at DESC',
    ),
    getNote: db.prepare('SELECT * FROM notes WHERE id = ?'),
    createNote: db.prepare(
      'INSERT INTO notes (id, project_id, title, content) VALUES (?, ?, ?, ?)',
    ),
    updateNote: db.prepare(
      "UPDATE notes SET title = ?, content = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    deleteNote: db.prepare('DELETE FROM notes WHERE id = ?'),

    // Bulk project cleanup (cascade handles child rows via FK constraints)
    deleteNotesByProject: db.prepare('DELETE FROM notes WHERE project_id = ?'),
    deleteWikiPagesByProject: db.prepare('DELETE FROM wiki_pages WHERE project_id = ?'),
    deleteWikiEmbeddingsByProject: db.prepare('DELETE FROM wiki_embeddings WHERE project_id = ?'),
    deleteWebhookConfigsByProject: db.prepare('DELETE FROM webhook_configs WHERE project_id = ?'),
    deleteBoardsByProject: db.prepare('DELETE FROM kanban_boards WHERE project_id = ?'),
    deleteWorkflowsByProject: db.prepare('DELETE FROM workflows WHERE project_id = ?'),
    deleteThreadsByProject: db.prepare('DELETE FROM threads WHERE project_id = ?'),
    deleteSessionAgentsByAgent: db.prepare('DELETE FROM session_agents WHERE agent_id = ?'),
    deleteCronsByProject: db.prepare('DELETE FROM crons WHERE project_id = ?'),
    deleteSessionsByAgent: db.prepare('DELETE FROM sessions WHERE agent_id = ?'),
    // Hard-delete: agent is not a DB table, so each child row store needs an
    // explicit by-agent delete. Sessions cascade messages/delegations/handoffs/
    // skill_invocations/background_tasks/message_queue automatically.
    deleteHeartbeatLogsByAgent: db.prepare('DELETE FROM heartbeat_logs WHERE agent_id = ?'),
    deleteSlackMessagesByAgent: db.prepare('DELETE FROM slack_messages WHERE agent_id = ?'),
    deleteActiveTasksByAgent: db.prepare('DELETE FROM active_tasks WHERE agent_id = ?'),
    deleteAgentSkillOverridesByAgent: db.prepare(
      'DELETE FROM agent_skill_overrides WHERE agent_id = ?',
    ),
    getRecentEscalationByTypeAndPr: db.prepare(
      `SELECT * FROM escalations WHERE project_id = ? AND type = ? AND pr_number = ? AND acknowledged = 0
       ORDER BY created_at DESC LIMIT 1`,
    ),
    getAnyRecentEscalationByTypeAndPr: db.prepare(
      `SELECT * FROM escalations WHERE project_id = ? AND type = ? AND pr_number = ?
       ORDER BY created_at DESC LIMIT 1`,
    ),

    // Note processings
    createNoteProcessing: db.prepare(
      `INSERT INTO note_processings (id, project_id, note_date, note_excerpt, target, status, session_id)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    ),
    updateNoteProcessing: db.prepare(
      `UPDATE note_processings SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ?`,
    ),
    updateNoteProcessingStatus: db.prepare(`UPDATE note_processings SET status = ? WHERE id = ?`),
    getNoteProcessing: db.prepare('SELECT * FROM note_processings WHERE id = ?'),
    getNoteProcessingsByProject: db.prepare(
      'SELECT * FROM note_processings WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
    ),
    getNoteProcessingsByDate: db.prepare(
      'SELECT * FROM note_processings WHERE project_id = ? AND note_date = ? ORDER BY created_at DESC',
    ),
    getNoteProcessingBySession: db.prepare('SELECT * FROM note_processings WHERE session_id = ?'),

    // iOS builds
    getIosBuilds: db.prepare('SELECT * FROM ios_builds ORDER BY created_at DESC'),
    getIosBuildsByProject: db.prepare(
      'SELECT * FROM ios_builds WHERE project_id = ? ORDER BY created_at DESC',
    ),
    getIosBuild: db.prepare('SELECT * FROM ios_builds WHERE id = ?'),
    createIosBuild: db.prepare(
      `INSERT INTO ios_builds (id, project_id, pr_number, pr_url, branch, commit_sha, repo_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateIosBuild: db.prepare(
      `UPDATE ios_builds SET status = ?, error_message = ?, build_log = ?,
       vm_instance_id = ?, ipa_url = ?, install_url = ?, simulator_recording_url = ?,
       qr_code_url = ?, duration_seconds = ?, xcode_version = ?, ios_sdk_version = ?,
       updated_at = datetime('now') WHERE id = ?`,
    ),
    updateIosBuildStatus: db.prepare(
      `UPDATE ios_builds SET status = ?, error_message = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    deleteIosBuild: db.prepare('DELETE FROM ios_builds WHERE id = ?'),
    appendIosBuildLog: db.prepare(
      `UPDATE ios_builds SET build_log = COALESCE(build_log, '') || ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    getRunningIosBuilds: db.prepare(
      `SELECT * FROM ios_builds WHERE status IN ('queued', 'provisioning', 'building', 'archiving', 'uploading')`,
    ),

    // iOS build artifacts
    getIosBuildArtifacts: db.prepare(
      'SELECT * FROM ios_build_artifacts WHERE build_id = ? ORDER BY type, name',
    ),
    createIosBuildArtifact: db.prepare(
      `INSERT INTO ios_build_artifacts (id, build_id, type, name, label, filename, file_path, file_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    deleteIosBuildArtifacts: db.prepare('DELETE FROM ios_build_artifacts WHERE build_id = ?'),

    // Provisioning jobs
    createProvisioningJob: db.prepare(
      `INSERT INTO provisioning_jobs (id, project_id, payload_json, status)
       VALUES (?, ?, ?, ?)`,
    ),
    finishProvisioningJob: db.prepare(
      `UPDATE provisioning_jobs
         SET status = ?, repo_url = ?, error_json = ?, finished_at = datetime('now')
       WHERE id = ?`,
    ),
    getProvisioningJob: db.prepare('SELECT * FROM provisioning_jobs WHERE id = ?'),
    getLatestProvisioningJobForProject: db.prepare(
      `SELECT * FROM provisioning_jobs
         WHERE project_id = ?
         ORDER BY started_at DESC
         LIMIT 1`,
    ),

    // Post-scaffold audit reports + roster (Act IV).
    upsertAuditReport: db.prepare(
      `INSERT INTO project_audit_reports (project_id, report_json, generated_at)
         VALUES (?, ?, datetime('now'))
       ON CONFLICT(project_id) DO UPDATE
         SET report_json = excluded.report_json,
             generated_at = excluded.generated_at`,
    ),
    getAuditReport: db.prepare(
      'SELECT report_json, generated_at FROM project_audit_reports WHERE project_id = ?',
    ),
    upsertProjectRoster: db.prepare(
      `INSERT INTO project_rosters (project_id, tracks_json, updated_at)
         VALUES (?, ?, datetime('now'))
       ON CONFLICT(project_id) DO UPDATE
         SET tracks_json = excluded.tracks_json,
             updated_at = excluded.updated_at`,
    ),
    getProjectRoster: db.prepare(
      'SELECT tracks_json, updated_at FROM project_rosters WHERE project_id = ?',
    ),

    // finalize_runs — pre-PR validation pipeline rows (Finalize Code Changes).
    // Phase 1 ships the rebase phase, so only the read + phase-update +
    // active-seconds + terminal-status statements are wired here. Insert and
    // idempotency-lookup statements land with the trigger-route work in a
    // follow-up phase, so this skeleton keeps the schema honest without
    // pretending the orchestrator exists yet.
    getFinalizeRun: db.prepare('SELECT * FROM finalize_runs WHERE id = ?'),
    // Idempotency lookup. The orchestrator hashes (project_id|branch|head_sha)
    // into the row's `idempotency_key`; a second trigger for the same tuple
    // returns the in-flight row (regardless of status). A new commit on the
    // branch produces a new `head_sha`, a new key, and therefore a new row.
    // See wiki finalize-code-changes-architecture-v0 (§4).
    getFinalizeRunByIdempotencyKey: db.prepare(
      'SELECT * FROM finalize_runs WHERE idempotency_key = ? LIMIT 1',
    ),
    // Insert a fresh finalize_runs row. The orchestrator owns the only
    // call-site — every other module mutates an existing row by id. UNIQUE
    // on `idempotency_key` enforces the §4 dedup contract at the DB layer.
    insertFinalizeRun: db.prepare(
      `INSERT INTO finalize_runs (
        id, card_id, session_id, project_id, branch, head_sha,
        idempotency_key, status, phase, trigger_source, worktree_path,
        triggered_by_user_id, author_name, author_email, retry_of_run_id,
        started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    // Promote a finalize run to its terminal `pushed` state and record the
    // ended_at clock in one atomic update. Used by the push step (§9) after
    // the PR URL has been written via `updateFinalizeRunPrUrl`.
    markFinalizeRunPushed: db.prepare(
      `UPDATE finalize_runs
          SET status = 'pushed',
              phase = 'push',
              ended_at = unixepoch() * 1000
        WHERE id = ?`,
    ),
    // Update the session id on a finalize_runs row. The orchestrator calls
    // this when it spawns or resolves a session after the row has been
    // inserted (the session may not exist at trigger time; see §6).
    updateFinalizeRunSessionId: db.prepare(`UPDATE finalize_runs SET session_id = ? WHERE id = ?`),
    // Update the worktree path on a finalize_runs row after the orchestrator
    // resolves it (the path may not be known at trigger time when a session
    // is spawned fresh).
    updateFinalizeRunWorktreePath: db.prepare(
      `UPDATE finalize_runs SET worktree_path = ? WHERE id = ?`,
    ),
    // Most-recent finalize run for a session. Used by the session-scoped
    // reviewer-threads side-panel to discover which run id to pull threads
    // for without forcing the client to track run lifecycle events. Returns
    // undefined when the session has never triggered a Finalize run — the
    // panel renders nothing in that case.
    //
    // Ordering: started_at DESC is the primary signal. The id DESC tiebreak
    // is defensive — two rows with the same `started_at` ms are possible
    // when the orchestrator dispatches two runs in the same tick, and we
    // need the picker to be deterministic across SQLite versions. Sorting
    // by a UUID is lexicographic but stable, which is all the tiebreak
    // needs to be.
    getLatestFinalizeRunForSession: db.prepare(
      `SELECT *
         FROM finalize_runs
        WHERE session_id = ?
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
    ),
    // In-flight finalize run for a session (status NOT IN terminal set).
    // The terminal status list is duplicated from
    // `server/finalize/budget.ts#FINALIZE_TERMINAL_STATUSES`; keep both
    // in sync if a new terminal status lands. Used by the chat.ts
    // session turn-end hook so a turn ending on a session bound to an
    // active finalize run bills its duration to that run.
    getActiveFinalizeRunForSession: db.prepare(
      `SELECT *
         FROM finalize_runs
        WHERE session_id = ?
          AND status NOT IN ('pushed', 'failed', 'timed_out', 'infra_error', 'cancelled', 'stalled_no_response')
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
    ),
    // Latest finalize run per (board-scoped) session. Returns one row per
    // distinct `session_id` that any card on `boardId` references *and*
    // that has finalize history. Used by `GET /api/projects/:id/board` to
    // fold the per-card badge state into the board payload — eliminates
    // the O(session-linked cards) per-card GET storm the v0 surface had
    // (PR #1169 reviewer feedback).
    //
    // Window-function picker — same tiebreak (started_at DESC, id DESC)
    // as `getLatestFinalizeRunForSession`, so single-card and board
    // queries agree on which run is "latest". `ROW_NUMBER()` is SQLite
    // 3.25+; `better-sqlite3` ships well above that floor.
    listLatestFinalizeRunsForBoard: db.prepare(
      `SELECT fr.id,
              fr.card_id,
              fr.session_id,
              fr.project_id,
              fr.branch,
              fr.head_sha,
              fr.idempotency_key,
              fr.status,
              fr.phase,
              fr.trigger_source,
              fr.worktree_path,
              fr.triggered_by_user_id,
              fr.author_name,
              fr.author_email,
              fr.reviewer_verdict,
              fr.failure_reason,
              fr.failed_step_index,
              fr.failed_step_name,
              fr.failed_step_exit_code,
              fr.retry_of_run_id,
              fr.active_seconds_consumed,
              fr.started_at,
              fr.ended_at,
              fr.pr_url
         FROM (
           SELECT finalize_runs.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY session_id
                    ORDER BY started_at DESC, id DESC
                  ) AS rn
             FROM finalize_runs
            WHERE session_id IN (
              SELECT DISTINCT session_id
                FROM kanban_cards
               WHERE board_id = ?
                 AND session_id IS NOT NULL
            )
         ) fr
        WHERE fr.rn = 1`,
    ),
    updateFinalizeRunPhase: db.prepare(
      `UPDATE finalize_runs
          SET phase = ?,
              status = ?
        WHERE id = ?`,
    ),
    updateFinalizeRunActiveSeconds: db.prepare(
      `UPDATE finalize_runs
          SET active_seconds_consumed = active_seconds_consumed + ?
        WHERE id = ?`,
    ),
    // Terminal-state write. Sets status + ended_at + (optional)
    // failure_reason. Used by rebase phase on `rebase_aborted` / `timeout`.
    failFinalizeRun: db.prepare(
      `UPDATE finalize_runs
          SET status = ?,
              failure_reason = ?,
              ended_at = unixepoch() * 1000
        WHERE id = ?`,
    ),
    // Update the reviewer's verdict on a finalize_runs row after the
    // review phase finishes. Used by the reviewer-dispatch helper to
    // record approved / changes_requested.
    updateFinalizeRunReviewerVerdict: db.prepare(
      `UPDATE finalize_runs
          SET reviewer_verdict = ?
        WHERE id = ?`,
    ),
    // Record the GitHub PR URL the push step opened for a finalize run.
    // Written atomically with the `git push` + `gh pr create` sequence
    // by the push gate (card 5c34b2de) so the webhook handler can use
    // a registry hit to mean "internal PR" with no risk of orphan rows.
    // See `server/finalize/provenance.ts` (design §11).
    updateFinalizeRunPrUrl: db.prepare(
      `UPDATE finalize_runs
          SET pr_url = ?
        WHERE id = ?`,
    ),
    // Reverse lookup for provenance classification: given an incoming PR
    // URL from a webhook, find the matching finalize_runs row (if any).
    // Presence = orchestrator-pushed (internal); absence triggers the
    // PR-body-marker fallback. See `server/finalize/provenance.ts`.
    getFinalizeRunByPrUrl: db.prepare('SELECT * FROM finalize_runs WHERE pr_url = ? LIMIT 1'),

    // reviewer_threads — diff-anchored notes produced by the reviewer
    // agent during the review phase. See wiki §8.
    insertReviewerThread: db.prepare(
      `INSERT INTO reviewer_threads
        (id, run_id, file_path, line_start, line_end, body, author, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    // Sort by file_path (NOT NULL in the schema), then line_start, then
    // created_at. `line_start` is nullable for file-level notes — we want
    // those to sort BEFORE numbered lines within the same file so the
    // side-panel renders the "general note about this file" header first.
    // SQLite happens to default `ASC` → NULLS FIRST, but the explicit
    // `NULLS FIRST` makes the contract grep-discoverable and survives
    // any future DB swap. See `server/routes/finalize.test.ts`.
    listReviewerThreadsForRun: db.prepare(
      `SELECT id, run_id, file_path, line_start, line_end, body, author, created_at
         FROM reviewer_threads
        WHERE run_id = ?
        ORDER BY file_path ASC,
                 line_start ASC NULLS FIRST,
                 created_at ASC`,
    ),
    deleteReviewerThreadsForRun: db.prepare('DELETE FROM reviewer_threads WHERE run_id = ?'),
  } as Stmts;

  dbRegistry.set(dataDir, { db, stmts });
}

function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized — call initDb() first');
  return db;
}

function getStmts(): Stmts {
  if (!stmts) throw new Error('Database not initialized — call initDb() first');
  return stmts;
}

initDb(config.dataDir);

export { db, stmts, initDb, getDb, getStmts };
