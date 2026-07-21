import Database from 'better-sqlite3';
import path from 'path';
import config from './config.js';
import { assertSafeTestDataDir } from './db-safety.js';
import { WORKFLOWS_SCHEMA, WORKFLOWS_WEBHOOK_PATH_INDEX_SQL } from './workflows-schema.js';
import { JOBS_SCHEMA } from './jobs/schema.js';
import {
  WORKTREE_PREVIEWS_SCHEMA,
  WORKTREE_PREVIEW_GROUPS_SCHEMA,
  MIGRATE_LEGACY_PREVIEWS_SQL,
} from './preview/preview-schema.js';
import { WORKTREE_PREVIEW_SECRETS_SCHEMA } from './preview/preview-secrets-schema.js';
import { BACKGROUND_SHELLS_SCHEMA } from './background-shells/background-shell-schema.js';
import { FINALIZE_METRICS_SCHEMA } from './finalize/metrics-schema.js';
import { FINALIZE_PARITY_SCHEMA } from './finalize/parity-store.js';
import { FINALIZE_SERVER_CI_SCHEMA } from './finalize/ci-config-store.js';
import { DEPLOYMENT_SCHEMA } from './deploy/deployment-schema.js';
import { DEPLOYMENT_ENV_RUNTIME_CONFIG_SCHEMA } from './deploy/deployment-env-config-schema.js';
import { DEPLOYMENT_ENV_TRIGGER_SCHEMA } from './deploy/deployment-trigger-schema.js';
import { DEPLOYMENT_ENV_SCHEDULE_SCHEMA } from './deploy/deployment-schedule-schema.js';
import { DEPLOYMENT_ENV_NOTIFICATION_ROUTING_SCHEMA } from './deploy/deployment-notification-routing-schema.js';
import { RELEASE_NOTIFICATION_SETTINGS_SCHEMA } from './release-notification-settings.js';
import {
  SECURITY_AUDIT_SCHEMA,
  migrateSecurityFindingsAddLastScanId,
} from './security-audit/findings-store.js';
import { collapseReviewColumn } from './migrations/collapse-review-column.js';
import { backfillPhaseAutonomousDefaults } from './migrations/backfill-phase-autonomous-defaults.js';
import {
  deriveCardPrefix,
  KANBAN_CARD_SHORT_ID_TRIGGER_SQL,
  KANBAN_BOARD_CARD_SEQ_RECONCILE_SQL,
} from './kanban-short-id.js';
import { installStatsCompletionTimestamps } from './stats-completion.js';
import type { Stmts } from './types.js';
import { configureDbInstrumentation, instrumentStmts } from './db-instrumentation.js';

let db: Database.Database | undefined;
let stmts: Stmts | undefined;

// Registry of opened db handles, keyed by dataDir. We deliberately keep prior
// connections open across org switches so in-flight CLI streams (which captured
// a reference to the old `stmts` object before the switch) can finish writing
// to their original database. Closing on switch would invalidate their prepared
// statements and crash the server with "database is closed" / FK errors.
const dbRegistry = new Map<string, { db: Database.Database; stmts: Stmts }>();

/**
 * Whether an existing `support_tickets` table DDL predates the `duplicate` /
 * `wont_do` lifecycle states and so needs its status CHECK rebuilt.
 *
 * Matches the QUOTED status literal `'wont_do'` (the value embedded in the
 * CHECK clause), NOT the bare substring: the `wont_do_reason` column — added by
 * an earlier migration step — also contains "wont_do", and a substring test
 * would mask a still-stale CHECK and silently skip the rebuild.
 */
export function supportTicketsStatusCheckNeedsRebuild(ddl: string): boolean {
  return Boolean(ddl) && !ddl.includes("'wont_do'");
}

/**
 * Initialize (or switch to) the database at the given data directory.
 * Creates tables, runs migrations, and prepares all statements on first use.
 * Subsequent calls for the same dataDir reuse the cached handle. Switching to
 * a different dataDir does NOT close the previous one.
 */
function initDb(dataDir: string): void {
  // Fail-closed: never let a test-runner process open a database outside
  // os.tmpdir(). This is the guard that would have prevented the 2026-07-01
  // prod kanban wipe (deploy tests ran with inherited AGENT_HUB_DATA_DIR=/data
  // and without the vitest setup isolation loading). See server/db-safety.ts.
  assertSafeTestDataDir(dataDir);

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

  // Pre-bootstrap migration: support_tickets.read_at. Like the webhook_events
  // block above, this must run before the bootstrap `db.exec` because that
  // block creates `idx_support_tickets_unread` on `(project_id, read_at)`.
  // Legacy installs where support_tickets already exists but read_at does not
  // would otherwise fail before the post-bootstrap migration can add it.
  try {
    db.exec('ALTER TABLE support_tickets ADD COLUMN read_at TEXT');
  } catch (_e) {
    /* table doesn't exist yet (fresh install) or column already present */
  }

  // rum_sessions enriched request facets: device_type/browser/os parsed from the
  // ingest User-Agent, geo_country resolved from the client IP (rum-enrichment.ts).
  // Added BEFORE the schema exec below so the (project_id, device_type|…) indexes
  // in that block can reference the columns on a legacy rum_sessions table where
  // CREATE TABLE IF NOT EXISTS is a no-op. Per-column try/catch so a partial prior
  // migration still completes. Fresh installs: the table doesn't exist yet, so the
  // ALTERs throw + are caught, and the CREATE TABLE below carries the columns.
  for (const col of ['device_type', 'browser', 'os', 'geo_country']) {
    try {
      db.exec(`ALTER TABLE rum_sessions ADD COLUMN ${col} TEXT`);
    } catch (_e) {
      /* table doesn't exist yet (fresh install) or column already present */
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      title_source TEXT,
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
      timezone TEXT,
      prompt TEXT NOT NULL,
      cwd TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run TEXT,
      last_result TEXT,
      timeout_ms INTEGER,
      notify_on_run INTEGER NOT NULL DEFAULT 0,
      engine TEXT,
      owner_user_id TEXT,
      shared INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS session_credential_requests (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      service TEXT NOT NULL,
      purpose TEXT NOT NULL,
      fields_json TEXT NOT NULL,
      values_enc TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      consumed_at TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_id, request_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_session_credential_requests_session
      ON session_credential_requests(session_id, updated_at);

    -- artifacts: per-session documents an agent generated (PDFs, scripts,
    -- reports, …). The bytes live in object storage (S3 or a local dir; see
    -- server/artifacts/artifact-store.ts); this table is the metadata index
    -- the Artifacts panel + agent script wrapper list/serve from.
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      storage_kind TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      storage_bucket TEXT,
      storage_region TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_session
      ON artifacts(session_id, created_at DESC);

    -- session_replays: metadata index for record-on-error rrweb session
    -- replays. The rrweb event array is gzipped and stored as a blob via the
    -- artifact store (S3 or a local dir; see server/artifacts/artifact-store.ts
    -- plus server/replays/replay-store.ts). This table is the durable index the
    -- paginated read API and support-ticket investigation resolve from. size is
    -- the COMPRESSED blob size (roughly 250-400 KB/session); uncompressed_size
    -- is the raw JSON length. support_ticket_id / card_id link a replay to the
    -- triage surface that referenced it.
    CREATE TABLE IF NOT EXISTS session_replays (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      -- Bumped on every write (insert + chunked append); powers the dashboard's
      -- "live"/in-progress signal for continuous captures. See migration block
      -- below for existing installs.
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      duration_ms INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      uncompressed_size INTEGER NOT NULL DEFAULT 0,
      storage_kind TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      storage_bucket TEXT,
      storage_region TEXT,
      -- Discriminates how the capture's bytes are laid out in storage:
      --   'monolithic' — legacy single gunzip-concat-regzip blob at storage_key
      --                  (O(n²) append; the record-on-error tier).
      --   'segmented'  — append-only per-segment S3 objects indexed by
      --                  rum_segments; storage_key is unused for byte reads.
      -- Legacy rows and every current storeReplay write are 'monolithic'. This
      -- column is the read-side discriminator; the append-only segment backend
      -- (server/replays/segment-store.ts) only writes rum_segments today and does
      -- NOT create a session_replays row. The 'segmented' value is stamped later,
      -- when the session-level metadata row is created + the playback API is
      -- wired to it (follow-up cards in this epic). Until then it exists so the
      -- monolithic read path stays explicit and the wiring is additive.
      storage_layout TEXT NOT NULL DEFAULT 'monolithic',
      support_ticket_id TEXT,
      card_id TEXT,
      -- Extended-retention flag (two-tier retention). When retained_until is a
      -- future SQLite-UTC instant the retention sweeper skips this row, keeping a
      -- flagged session past the default window (up to 15 months). retained_until
      -- is absolute because the 15-month clock starts when the flag is ENABLED
      -- (retention_flagged_at), not at capture. Both NULL = not flagged.
      -- See server/replays/replay-retention.ts + POST /api/replays/:id/retention.
      retained_until TEXT,
      retention_flagged_at TEXT,
      meta TEXT
    );
    -- Also serves the per-tenant BASE-retention override sweep
    -- (getExpiredUnlinkedSessionReplaysByProject: WHERE project_id = ? AND
    -- created_at < ? ORDER BY created_at ASC): the (project_id, created_at)
    -- composite seeks straight to the tenant's rows, and SQLite reverse-scans the
    -- DESC index to satisfy the ASC LIMIT without a full sort — so no separate ASC
    -- index is needed.
    CREATE INDEX IF NOT EXISTS idx_session_replays_project
      ON session_replays(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_session_replays_ticket
      ON session_replays(support_ticket_id);

    -- rum_segments: the append-only segment manifest for 'segmented' captures.
    -- Each row indexes ONE gzipped S3 object holding a view-scoped slice of rrweb
    -- events (~5s or ~60KB, flushed on view_change / page-exit). S3 is the byte
    -- source of truth; this table is the pointer + metadata index playback lists
    -- and orders by. Append is O(1): one PUT + one INSERT, never re-reading prior
    -- segments. The UNIQUE (session_id, view_id, index_in_view) makes an
    -- index-slot double-write fail instead of silently clobbering a segment.
    -- has_full_snapshot marks index_in_view=0 (every view opens with a fresh full
    -- snapshot). start_ts/end_ts are epoch-ms spans; byte_size is the gzipped
    -- object size. storage_kind/bucket/region mirror session_replays so a read
    -- resolves the ORIGINAL backend even after config changes.
    CREATE TABLE IF NOT EXISTS rum_segments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      view_id TEXT NOT NULL,
      project_id TEXT,
      index_in_view INTEGER NOT NULL,
      has_full_snapshot INTEGER NOT NULL DEFAULT 0,
      start_ts INTEGER NOT NULL DEFAULT 0,
      end_ts INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      byte_size INTEGER NOT NULL DEFAULT 0,
      storage_kind TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      storage_bucket TEXT,
      storage_region TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rum_segments_slot
      ON rum_segments(session_id, view_id, index_in_view);
    -- Playback manifest: chronological across views, sequential within a view.
    CREATE INDEX IF NOT EXISTS idx_rum_segments_session
      ON rum_segments(session_id, start_ts, index_in_view);
    -- Retention sweep: age-ordered scan for the orphan-segment reconciliation
    -- pass (WHERE created_at < ? ORDER BY created_at). Without it the sweep scans
    -- + sorts the whole segment index every interval as it grows toward retention.
    CREATE INDEX IF NOT EXISTS idx_rum_segments_created_at
      ON rum_segments(created_at);
    -- Per-tenant BASE-retention override sweep: getExpiredOrphanRumSegmentsByProject
    -- runs (WHERE project_id = ? AND created_at < ? ...) once per overriding tenant
    -- every sweep. This composite seeks straight to the tenant's aged orphan
    -- segments instead of scanning the whole global age range per tenant.
    CREATE INDEX IF NOT EXISTS idx_rum_segments_project_created
      ON rum_segments(project_id, created_at);

    -- rum_sessions: the session-grain metadata row the RUM dashboard lists and
    -- filters on (Datadog "session" grain). One row per client-minted session id,
    -- carrying rollup aggregates maintained incrementally as segments are ingested
    -- (server/replays/rum-session-store.ts):
    --   view_count        — distinct views (each view opens with an index_in_view=0
    --                       segment, counted exactly once).
    --   action_count      — sum of per-segment action counts (client-sent meta).
    --   error_count       — sum of per-segment error counts.
    --   frustration_count — sum of per-segment frustration counts (rage/dead/error
    --                       click; detected client-side, sent as counts).
    --   started_at/ended_at — earliest/latest event timestamp across the whole
    --                       session, epoch ms; time_spent = ended_at - started_at.
    -- project_id is first-non-null-wins so an anonymous first segment that later
    -- attributes keeps its tenant. Per-user identity is carried by
    -- usr_id/usr_email/usr_name + usr_attributes (custom attributes, JSON): the
    -- client stamps usr onto segment meta forward-only, and the rollup keeps the
    -- LAST non-null value per field so a session that identifies mid-stream still
    -- shows a user in the dashboard "User Email" column. Identity is tenant-scoped
    -- PII. The enriched request facet columns device_type/browser/os (parsed from
    -- the ingest User-Agent) and geo_country (resolved from the client IP) are
    -- computed once per session (first-non-null-wins) at ingest by
    -- server/replays/rum-enrichment.ts. The (project_id, started_at) index backs
    -- the tenant-scoped, time-ranged list query; the (project_id, usr_*) and
    -- (project_id, device_type|browser|os|geo_country) indexes back the
    -- tenant-scoped username and facet filters.
    CREATE TABLE IF NOT EXISTS rum_sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      time_spent INTEGER NOT NULL DEFAULT 0,
      view_count INTEGER NOT NULL DEFAULT 0,
      action_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      frustration_count INTEGER NOT NULL DEFAULT 0,
      usr_id TEXT,
      usr_email TEXT,
      usr_name TEXT,
      usr_attributes TEXT,
      device_type TEXT,
      browser TEXT,
      os TEXT,
      geo_country TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rum_sessions_project
      ON rum_sessions(project_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rum_sessions_usr_email
      ON rum_sessions(project_id, usr_email);
    CREATE INDEX IF NOT EXISTS idx_rum_sessions_usr_id
      ON rum_sessions(project_id, usr_id);
    CREATE INDEX IF NOT EXISTS idx_rum_sessions_usr_name
      ON rum_sessions(project_id, usr_name);
    CREATE INDEX IF NOT EXISTS idx_rum_sessions_device_type
      ON rum_sessions(project_id, device_type);
    CREATE INDEX IF NOT EXISTS idx_rum_sessions_browser
      ON rum_sessions(project_id, browser);
    CREATE INDEX IF NOT EXISTS idx_rum_sessions_os
      ON rum_sessions(project_id, os);
    CREATE INDEX IF NOT EXISTS idx_rum_sessions_geo_country
      ON rum_sessions(project_id, geo_country);
    -- Retention sweep: age-ordered scan for the expired-session pass
    -- (WHERE updated_at < ? ORDER BY updated_at). Without it the sweep scans +
    -- sorts the whole session index every interval as it grows toward retention.
    CREATE INDEX IF NOT EXISTS idx_rum_sessions_updated_at
      ON rum_sessions(updated_at);
    -- Per-tenant BASE-retention override sweep: getExpiredRumSessionsByProject
    -- runs (WHERE project_id = ? AND updated_at < ? ORDER BY updated_at) once per
    -- overriding tenant every sweep. The global idx_rum_sessions_updated_at would
    -- force each of those to scan the whole global age range and filter by
    -- project; this composite seeks straight to the tenant's rows in age order.
    CREATE INDEX IF NOT EXISTS idx_rum_sessions_project_updated
      ON rum_sessions(project_id, updated_at);

    -- project_rum_clients: per-project RUM (real user monitoring) ingest
    -- credentials. A third-party vendor site authenticates a replay upload to
    -- POST /api/replays with an X-RUM-Token header; a valid token attributes
    -- the capture to its project and applies a per-project ingest budget. Token
    -- handling mirrors api_keys (api-keys-store.ts): a rum_-prefixed CSPRNG
    -- token whose plaintext is returned ONCE at mint, with only the sha256 hex
    -- (token_hash, UNIQUE) and the indexed prefix persisted. revoked_at soft-
    -- deletes. Unlike api_keys (shared orgs.db, per-user) these are project-
    -- scoped, so they live in the per-org main DB alongside session_replays.
    CREATE TABLE IF NOT EXISTS project_rum_clients (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_project_rum_clients_project
      ON project_rum_clients(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_rum_clients_prefix
      ON project_rum_clients(prefix);

    -- replay_playlists: named, project-scoped groups of saved replay captures
    -- (Datadog "playlist"). A whole playlist can be flagged for extended
    -- retention, reusing the per-session two-tier model: flagging stamps an
    -- absolute retained_until (enable-time + the tenant's extension window) on
    -- the playlist AND fans the same flag out onto every member capture's
    -- session_replays row, so the retention sweeper skips them until the window
    -- lapses. extended_retention is the 0/1 flag; retained_until /
    -- retention_flagged_at mirror session_replays' columns (SQLite-UTC instants,
    -- both NULL = not flagged). See server/replays/replay-playlist-store.ts +
    -- server/routes/replay-playlists.ts.
    CREATE TABLE IF NOT EXISTS replay_playlists (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      extended_retention INTEGER NOT NULL DEFAULT 0,
      retained_until TEXT,
      retention_flagged_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_replay_playlists_project
      ON replay_playlists(project_id, created_at DESC);

    -- replay_playlist_items: membership join. A playlist references saved
    -- monolithic session_replays captures (the rows that carry retained_until —
    -- the same grain the per-session retention flag operates on). ON DELETE
    -- CASCADE removes items when the playlist is dropped. position orders the
    -- playlist; added_at records when the capture joined. The composite PK makes
    -- re-adding the same capture idempotent (INSERT OR IGNORE).
    CREATE TABLE IF NOT EXISTS replay_playlist_items (
      playlist_id TEXT NOT NULL,
      replay_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (playlist_id, replay_id),
      FOREIGN KEY (playlist_id) REFERENCES replay_playlists(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_replay_playlist_items_playlist
      ON replay_playlist_items(playlist_id, position, added_at);
    CREATE INDEX IF NOT EXISTS idx_replay_playlist_items_replay
      ON replay_playlist_items(replay_id);

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
      -- Monotonic per-board counter backing each card's human-readable short id
      -- (e.g. "AH-123"). Only ever incremented — deleting a card never frees its
      -- number, so short ids stay stable and never collide after a delete.
      card_seq INTEGER NOT NULL DEFAULT 0,
      -- Persisted alphabetic prefix for human card ids (the "AH" in "AH-123").
      -- Frozen at board creation from the immutable project slug so that
      -- renaming a project never rewrites existing, already-shared card ids.
      card_prefix TEXT,
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
      -- Durable source support ticket / customer report link. Reporter PII
      -- remains on support_tickets; cards carry only stable ids.
      support_ticket_id TEXT,
      customer_report_id TEXT,
      -- Capture provenance (spec CAPTURE-PROVENANCE): the shared source triple
      -- with user_todos so a card can be traced back to the Gmail message /
      -- Calendar event / todo it was captured from. NULL for cards created
      -- without a tracked origin. source_meta is a JSON deep-link blob.
      source_type TEXT CHECK(source_type IS NULL OR source_type IN ('manual','email','calendar','todo','log_issue')),
      source_id TEXT,
      source_meta TEXT,
      created_by TEXT,
      -- Human-readable per-board sequence number (the "123" in "AH-123").
      -- Assigned by the kanban_card_assign_short_id trigger on insert; NULL only
      -- transiently before the trigger fires (and on pre-migration legacy rows
      -- until backfilled).
      short_id INTEGER,
      position INTEGER NOT NULL DEFAULT 0,
      -- Timestamp the card entered a Done column (NULL = not completed).
      -- Maintained by the kanban_cards_set_completed_at_* triggers (see
      -- stats-completion.ts) so day/week/month completion buckets are accurate
      -- regardless of which code path moved the card. Cleared on move-out.
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (column_id) REFERENCES kanban_columns(id) ON DELETE CASCADE,
      FOREIGN KEY (board_id) REFERENCES kanban_boards(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_cards_column ON kanban_cards(column_id);
    CREATE INDEX IF NOT EXISTS idx_kanban_cards_board ON kanban_cards(board_id);
    -- Composite index backing keyset pagination of a column's cards ordered by
    -- (position, id). Covers both the first-page and after-cursor fetches plus
    -- the per-column COUNT(*) used to build the board counts map.
    CREATE INDEX IF NOT EXISTS idx_kanban_cards_column_position
      ON kanban_cards(column_id, position, id);

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
      state TEXT DEFAULT NULL
        CHECK (state IS NULL OR state IN ('not_started', 'in_progress', 'done')),
      color TEXT NOT NULL DEFAULT '#6366F1',
      autonomous INTEGER NOT NULL DEFAULT 0,
      autonomous_interval INTEGER NOT NULL DEFAULT 5,
      autonomous_max_concurrent INTEGER NOT NULL DEFAULT 1,
      autonomous_model TEXT DEFAULT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      -- Timestamp the epic reached state='done' (NULL = not completed).
      -- Maintained by the kanban_epics_set_completed_at_* triggers
      -- (stats-completion.ts). Cleared if the epic leaves the done state.
      completed_at TEXT,
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

    -- Legacy webhook tables (webhook_configs / webhook_logs / webhook_events).
    -- The GitHub App + inbound-webhook feature was removed in PR #149; the
    -- webhook DB layer (prepared statements, worker, routes) is gone. These
    -- tables are deliberately RETAINED, not dropped, for two reasons:
    --   1. migrateWebhookRepoToProject (server/project-model.ts) reads
    --      webhook_configs.repo_url on boot to recover a project's GitHub
    --      repo association on upgrade. Dropping the table would erase that
    --      upgrade path before every install has run the migration.
    --   2. They preserve historical webhook delivery/audit rows for backups.
    -- Safe to remove in a future migration once all installs have upgraded
    -- past the webhook era and run the repo migration at least once.
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

    -- Support tickets: customer support requests persisted in their OWN
    -- project-scoped queue, deliberately separate from the kanban board. The
    -- status lifecycle (new -> investigating -> converted / closed) is distinct
    -- from kanban columns; the severity column drives list ordering.
    -- AI-investigation columns (ai_summary / ai_investigation /
    -- ai_investigated_at) and the optional session-replay reference
    -- (replay_ref) are written by downstream features (AI triage, replay
    -- attach). converted_card_id records the kanban card a ticket was promoted
    -- to when status becomes 'converted'.
    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'other'
        CHECK(type IN ('bug','question','feature_request','incident','other')),
      severity TEXT NOT NULL DEFAULT 'medium'
        CHECK(severity IN ('critical','high','medium','low')),
      status TEXT NOT NULL DEFAULT 'new'
        CHECK(status IN ('new','investigating','converted','closed','duplicate','wont_do')),
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      reporter TEXT,
      reporter_email TEXT,
      ai_summary TEXT,
      ai_investigation TEXT,
      ai_investigated_at TEXT,
      replay_ref TEXT,
      -- Operator-supplied reason a ticket was marked 'wont_do' (NULL otherwise).
      -- See migration block below for existing installs.
      wont_do_reason TEXT,
      -- Optional server-relative ref to a screenshot the reporter attached
      -- (/uploads/support-screenshot-<id>.<ext>). See migration block below for
      -- existing installs.
      screenshot_ref TEXT,
      converted_card_id TEXT,
      -- Timestamp a human first viewed the ticket (NULL = unread). Drives the
      -- per-project unread counter on the Support sidebar item. Global per
      -- project, not per-user (matches escalations.acknowledged). See migration
      -- block below for existing installs.
      read_at TEXT,
      -- Release-facing lifecycle. release_state is derived in route
      -- serialization from these timestamps so support-ticket status remains
      -- independent from card/deploy/customer notification state.
      fixed_at TEXT,
      released_to_prod_at TEXT,
      release_deployment_id TEXT,
      customer_notified_at TEXT,
      -- Timestamp the ticket reached a terminal status (converted/closed/
      -- duplicate/wont_do); NULL while still open. Maintained by the
      -- support_tickets_set_resolved_at_* triggers (stats-completion.ts) so the
      -- Stats page can bucket "tickets resolved" by day/week/month. Cleared if
      -- the ticket is reopened to new/investigating.
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_support_tickets_project ON support_tickets(project_id);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_status
      ON support_tickets(project_id, status);
    -- idx_support_tickets_unread is created in the migration block below after
    -- read_at is ensured on legacy installs (bootstrap index here would fail
    -- when support_tickets exists without the column).

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
      pr_url TEXT,
      validated_head_sha TEXT,
      mode TEXT NOT NULL DEFAULT 'full',
      -- JSON array of ci.yaml v2 job ids for single-job debug runs; NULL = all jobs.
      job_filter TEXT
    );
    CREATE INDEX IF NOT EXISTS finalize_runs_card ON finalize_runs(card_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS finalize_runs_session ON finalize_runs(session_id);
    -- getActiveFinalizeRuns runs on every WS-connect handshake (finalize
    -- snapshot): active (non-terminal) runs ORDER BY started_at DESC, id DESC.
    -- Nearly all rows are terminal, so a partial index over just the active
    -- runs, pre-ordered by (started_at DESC, id DESC), turns a full scan +
    -- TEMP B-TREE into a short ordered index scan. Both the WHERE clause (to
    -- match the query's status predicate verbatim) and the full ORDER BY
    -- tiebreak (started_at, then id) must be covered or SQLite falls back to a
    -- TEMP B-TREE for the last ORDER BY term.
    CREATE INDEX IF NOT EXISTS idx_finalize_runs_active ON finalize_runs(started_at DESC, id DESC)
      WHERE status NOT IN ('pushed','failed','timed_out','infra_error','cancelled','stalled_no_response');
    CREATE TABLE IF NOT EXISTS finalize_kickoff_claims (
      claim_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      mode TEXT NOT NULL,
      job_filter TEXT,
      created_at INTEGER NOT NULL
    );

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

    -- Per-step CI task state for Finalize runs (checks panel + log viewer).
    CREATE TABLE IF NOT EXISTS finalize_run_steps (
      run_id TEXT NOT NULL REFERENCES finalize_runs(id),
      step_index INTEGER NOT NULL,
      name TEXT NOT NULL,
      state TEXT NOT NULL,
      exit_code INTEGER,
      started_at INTEGER,
      ended_at INTEGER,
      job_id TEXT,
      matrix_key TEXT,
      log_storage_kind TEXT,
      log_storage_bucket TEXT,
      log_storage_region TEXT,
      log_key TEXT,
      log_lines INTEGER,
      log_truncated INTEGER,
      log_attempt TEXT,
      PRIMARY KEY (run_id, step_index)
    );
    CREATE INDEX IF NOT EXISTS finalize_run_steps_run
      ON finalize_run_steps(run_id, step_index);
  `);

  // Finalize Code Changes adoption metrics — append-only event log.
  // See `server/finalize/metrics-schema.ts` for the column contract and
  // `server/finalize/metrics.ts` for the emitter / aggregation surface.
  db.exec(FINALIZE_METRICS_SCHEMA);

  // Finalize↔GitHub parity harness — one row per (project, commit) recording
  // the Finalize verdict vs the GitHub Actions verdict + divergence class. See
  // `server/finalize/parity-store.ts`.
  db.exec(FINALIZE_PARITY_SCHEMA);

  // Server-stored Finalize CI config — the fallback for repos that do not commit
  // `.agent-hub/ci.yaml`. One row per (project, scope). See
  // `server/finalize/ci-config-store.ts`.
  db.exec(FINALIZE_SERVER_CI_SCHEMA);

  // Dependency security audit — vulnerable-dependency findings + operator
  // suppressions for Hub-hosted repos. See `server/security-audit/`.
  db.exec(SECURITY_AUDIT_SCHEMA);
  // Heal installs whose security_findings table predates the last_scan_id
  // column — CREATE TABLE IF NOT EXISTS never adds it, so legacy DBs threw
  // `no column named last_scan_id` on every scan store. Idempotent.
  migrateSecurityFindingsAddLastScanId(db);

  // Per-project release notification settings. Stores only operator guidance;
  // release digest generation remains bounded by the fixed server template.
  db.exec(RELEASE_NOTIFICATION_SETTINGS_SCHEMA);

  // Native pull requests — DB-backed PRs for Agent Hub-hosted projects
  // (Project.gitHost === 'agenthub'). The PR's git side (diff, files,
  // merge) is computed against the hosted bare repo (server/git-host/);
  // this table is the metadata + numbering authority. `number` is
  // per-project and allocated transactionally in server/native-pr/store.ts.
  // status: 'open' | 'merged' | 'closed'. Timestamps are epoch ms
  // (serialized to ISO at the API edge for GitHub-shape compatibility).
  db.exec(`
    CREATE TABLE IF NOT EXISTS pull_requests (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      head_branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      author TEXT NOT NULL,
      merged_sha TEXT,
      merged_by TEXT,
      merge_method TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      merged_at INTEGER,
      closed_at INTEGER,
      review_requested_at INTEGER,
      review_requested_by TEXT,
      UNIQUE(project_id, number)
    );
    CREATE INDEX IF NOT EXISTS pull_requests_project
      ON pull_requests(project_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS pull_requests_head
      ON pull_requests(project_id, head_branch);

    -- Human reviews on native PRs (approve / request changes / comment).
    -- Shape mirrors GitHub's review objects so the existing client review
    -- UI (badges, activity timeline, autofix context) renders them
    -- unchanged. The Finalize reviewer agent remains a separate system.
    CREATE TABLE IF NOT EXISTS pull_request_reviews (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      reviewer TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('approved', 'changes_requested', 'commented')),
      body TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pull_request_reviews_pr
      ON pull_request_reviews(project_id, pr_number, created_at ASC);

    -- Inline (per-line) review comments on native PR diffs, anchored to a
    -- file + line in the PR's unified diff. side 'new' anchors to the
    -- post-image line number (additions/context), 'old' to the pre-image
    -- (deletions). Rendered inside the Files-changed diff and folded into
    -- the Autofix prompt context.
    CREATE TABLE IF NOT EXISTS pull_request_comments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      author TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line INTEGER NOT NULL,
      side TEXT NOT NULL DEFAULT 'new' CHECK(side IN ('old', 'new')),
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pull_request_comments_pr
      ON pull_request_comments(project_id, pr_number, file_path, line);
  `);

  // The pull_requests table shipped without the review-request columns in
  // the same dev cycle — heal existing local DBs (no-op once present).
  for (const col of ['review_requested_at INTEGER', 'review_requested_by TEXT']) {
    try {
      db.exec(`ALTER TABLE pull_requests ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }

  try {
    db.prepare('SELECT step_index FROM finalize_run_steps LIMIT 1').get();
  } catch {
    db.exec(`
      CREATE TABLE IF NOT EXISTS finalize_run_steps (
        run_id TEXT NOT NULL REFERENCES finalize_runs(id),
        step_index INTEGER NOT NULL,
        name TEXT NOT NULL,
        state TEXT NOT NULL,
        exit_code INTEGER,
        started_at INTEGER,
        ended_at INTEGER,
        PRIMARY KEY (run_id, step_index)
      );
      CREATE INDEX IF NOT EXISTS finalize_run_steps_run
        ON finalize_run_steps(run_id, step_index);
    `);
  }

  // session_replays.updated_at — added for the continuous-replay dashboard's
  // live/in-progress signal. ALTER ADD COLUMN can't take a non-constant default,
  // so add it nullable and backfill existing rows to created_at; new installs
  // get the NOT NULL DEFAULT from CREATE TABLE above. Appends bump it going
  // forward (see updateSessionReplayStats / ...ForAppend).
  try {
    db.prepare('SELECT updated_at FROM session_replays LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE session_replays ADD COLUMN updated_at TEXT');
    db.exec('UPDATE session_replays SET updated_at = created_at WHERE updated_at IS NULL');
  }

  // session_replays.storage_layout — discriminates monolithic (legacy blob) vs
  // segmented (rum_segments) byte layout so old captures stay readable. A string
  // literal is a constant default, so ADD COLUMN can carry the NOT NULL DEFAULT
  // directly; existing rows adopt 'monolithic'.
  try {
    db.prepare('SELECT storage_layout FROM session_replays LIMIT 1').get();
  } catch {
    db.exec(
      "ALTER TABLE session_replays ADD COLUMN storage_layout TEXT NOT NULL DEFAULT 'monolithic'",
    );
  }

  // session_replays extended-retention flag columns. Both nullable TEXT (SQLite
  // UTC instants), so plain ADD COLUMN; existing rows read NULL = not flagged and
  // stay on the default retention window. Probe one column to detect the pair.
  try {
    db.prepare('SELECT retained_until FROM session_replays LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE session_replays ADD COLUMN retained_until TEXT');
    db.exec('ALTER TABLE session_replays ADD COLUMN retention_flagged_at TEXT');
  }

  // rum_sessions per-user identity columns. The client stamps `usr` onto segment
  // meta forward-only; the rollup splits standard fields into indexed columns and
  // keeps custom attributes as JSON, retaining the LAST non-null value per field.
  // All nullable TEXT, so plain ADD COLUMN; existing rows read NULL (anonymous).
  try {
    db.prepare('SELECT usr_id FROM rum_sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE rum_sessions ADD COLUMN usr_id TEXT');
    db.exec('ALTER TABLE rum_sessions ADD COLUMN usr_email TEXT');
    db.exec('ALTER TABLE rum_sessions ADD COLUMN usr_name TEXT');
    db.exec('ALTER TABLE rum_sessions ADD COLUMN usr_attributes TEXT');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_rum_sessions_usr_email ON rum_sessions(project_id, usr_email)',
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_rum_sessions_usr_id ON rum_sessions(project_id, usr_id)',
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_rum_sessions_usr_name ON rum_sessions(project_id, usr_name)',
    );
  }

  try {
    db.prepare('SELECT validated_head_sha FROM finalize_runs LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE finalize_runs ADD COLUMN validated_head_sha TEXT');
  }

  try {
    db.prepare('SELECT loop_round FROM finalize_runs LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE finalize_runs ADD COLUMN loop_round INTEGER NOT NULL DEFAULT 0');
  }

  try {
    db.prepare('SELECT mode FROM finalize_runs LIMIT 1').get();
  } catch {
    db.exec("ALTER TABLE finalize_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'full'");
  }

  // job_filter: JSON array of ci.yaml v2 job ids for single-job "Run Tests"
  // dropdown runs. NULL for normal runs (every job). Job-filtered rows are
  // excluded from the per-phase pickers below so a debug run never flips the
  // "Tested" badge or claims full validation.
  try {
    db.prepare('SELECT job_filter FROM finalize_runs LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE finalize_runs ADD COLUMN job_filter TEXT');
  }

  // flake_recovered_jobs: JSON array of per-job verdicts for jobs that passed
  // only after retrying within the run, with no fixer commit touching their
  // code paths (see server/finalize/flake-recovery.ts). NULL when the run had
  // no laundered flakes. Non-NULL blocks auto-push/auto-merge — a human must
  // push manually to acknowledge the flake recovery.
  try {
    db.prepare('SELECT flake_recovered_jobs FROM finalize_runs LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE finalize_runs ADD COLUMN flake_recovered_jobs TEXT');
  }

  try {
    db.prepare('SELECT job_id FROM finalize_run_steps LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE finalize_run_steps ADD COLUMN job_id TEXT');
    db.exec('ALTER TABLE finalize_run_steps ADD COLUMN matrix_key TEXT');
  }

  // Per-step CI output is stored as a single blob in the finalize log store
  // (S3 or local dir) rather than streamed into the session message log. These
  // columns record where each step's blob lives so reads resolve the original
  // backend even after the Hub's storage config changes. NULL for legacy rows
  // whose output still lives in `messages` (the route falls back to scanning).
  try {
    db.prepare('SELECT log_key FROM finalize_run_steps LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE finalize_run_steps ADD COLUMN log_storage_kind TEXT');
    db.exec('ALTER TABLE finalize_run_steps ADD COLUMN log_storage_bucket TEXT');
    db.exec('ALTER TABLE finalize_run_steps ADD COLUMN log_storage_region TEXT');
    db.exec('ALTER TABLE finalize_run_steps ADD COLUMN log_key TEXT');
    db.exec('ALTER TABLE finalize_run_steps ADD COLUMN log_lines INTEGER');
    db.exec('ALTER TABLE finalize_run_steps ADD COLUMN log_truncated INTEGER');
  }

  // Per-execution nonce: a unique token stamped when each step execution
  // starts, used as the blob-key attempt segment and the attach guard so a
  // re-run of the same (run_id, step_index) can't be clobbered by a stale
  // upload. (ms `ended_at` is not collision-safe for same-millisecond reruns.)
  try {
    db.prepare('SELECT log_attempt FROM finalize_run_steps LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE finalize_run_steps ADD COLUMN log_attempt TEXT');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS finalize_run_jobs (
      run_id TEXT NOT NULL REFERENCES finalize_runs(id),
      job_id TEXT NOT NULL,
      matrix_key TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      exit_code INTEGER,
      started_at INTEGER,
      ended_at INTEGER,
      attempt TEXT,
      PRIMARY KEY (run_id, job_id, matrix_key)
    );
    CREATE INDEX IF NOT EXISTS finalize_run_jobs_run
      ON finalize_run_jobs(run_id, job_id);
  `);

  // Per-execution nonce for finalize_run_jobs, mirroring finalize_run_steps'
  // log_attempt: minted when a job execution starts, echoed by its terminal
  // write as the out-of-order guard in upsertFinalizeRunJob. A wall-clock
  // stamp is NOT collision-safe (a retry/fix-round restart can land in the
  // same millisecond), so identity must be a nonce.
  try {
    db.prepare('SELECT attempt FROM finalize_run_jobs LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE finalize_run_jobs ADD COLUMN attempt TEXT');
  }

  // Per-round job/matrix retry history. finalize_run_jobs holds only the
  // LATEST state per instance (it upserts in place); this table appends one
  // row per loop_round so the flake-recovery classifier can see "failed round
  // N, passed round M". head_sha is the post-rebase HEAD the round validated
  // against, which lets the classifier ask whether a fixer commit landed
  // between the failing and passing rounds.
  db.exec(`
    CREATE TABLE IF NOT EXISTS finalize_run_job_attempts (
      run_id TEXT NOT NULL REFERENCES finalize_runs(id),
      job_id TEXT NOT NULL,
      matrix_key TEXT NOT NULL DEFAULT '',
      round INTEGER NOT NULL,
      state TEXT NOT NULL,
      exit_code INTEGER,
      head_sha TEXT,
      recorded_at INTEGER,
      PRIMARY KEY (run_id, job_id, matrix_key, round)
    );
    CREATE INDEX IF NOT EXISTS finalize_run_job_attempts_run
      ON finalize_run_job_attempts(run_id);
  `);

  // Cross-run per-instance flake history. One row per (run, job instance)
  // collapsing that run's per-round attempts into a final state + whether the
  // instance flaked within the run (failed→passed). Unlike
  // finalize_run_job_attempts (scoped to one run, keyed by run_id), this table
  // is project-scoped so the flake-rate computation can read an instance's
  // outcomes across many runs without joining back to finalize_runs.
  db.exec(`
    CREATE TABLE IF NOT EXISTS finalize_test_history (
      run_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      matrix_key TEXT NOT NULL DEFAULT '',
      branch TEXT,
      head_sha TEXT,
      final_state TEXT NOT NULL,
      flaked INTEGER NOT NULL DEFAULT 0,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, job_id, matrix_key)
    );
    CREATE INDEX IF NOT EXISTS finalize_test_history_instance
      ON finalize_test_history(project_id, job_id, matrix_key, recorded_at DESC);
  `);

  // Quarantine lane. A flaky job instance can be quarantined: it still runs
  // every round (monitoring data keeps flowing into finalize_test_history) but
  // its flake-recovery no longer blocks the push gate. Time-bounded (≤30 days,
  // enforced in server/finalize/quarantine.ts) with a named owner so it cannot
  // become a permanent escape hatch — an expired entry is surfaced as overdue.
  db.exec(`
    CREATE TABLE IF NOT EXISTS finalize_quarantine (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      matrix_key TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL,
      reason TEXT,
      quarantined_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_by TEXT,
      UNIQUE (project_id, job_id, matrix_key)
    );
    CREATE INDEX IF NOT EXISTS finalize_quarantine_project
      ON finalize_quarantine(project_id);
  `);

  try {
    db.prepare('SELECT next_run_at FROM crons LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE crons ADD COLUMN next_run_at TEXT');
  }

  try {
    db.prepare('SELECT timezone FROM crons LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE crons ADD COLUMN timezone TEXT');
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

  // Logical user id for the Hub user that created the cron. Scheduled crons
  // run outside an interactive session, but credentials such as AWS SSO live
  // under per-user HOME trees, so cron execution needs this owner to build the
  // same spawn env the creator would get.
  try {
    db.prepare('SELECT owner_user_id FROM crons LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE crons ADD COLUMN owner_user_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_crons_owner ON crons(owner_user_id)');

  try {
    db.prepare('SELECT shared FROM crons LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE crons ADD COLUMN shared INTEGER NOT NULL DEFAULT 0');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_crons_shared ON crons(shared)');

  const heartbeatStateColumns = db.prepare('PRAGMA table_info(heartbeat_state)').all() as Array<{
    name: string;
  }>;
  const heartbeatStateHasOwnershipColumns = heartbeatStateColumns.some(
    (column) => column.name === 'owner_user_id' || column.name === 'shared',
  );
  if (heartbeatStateHasOwnershipColumns) {
    db.exec(`
      DROP INDEX IF EXISTS idx_heartbeat_state_owner;
      DROP INDEX IF EXISTS idx_heartbeat_state_shared;
      DROP TABLE IF EXISTS heartbeat_state_next;
      CREATE TABLE heartbeat_state_next (
        agent_id TEXT PRIMARY KEY,
        next_run_at TEXT,
        last_run_at TEXT
      );
      INSERT OR REPLACE INTO heartbeat_state_next (agent_id, next_run_at, last_run_at)
        SELECT agent_id, next_run_at, last_run_at FROM heartbeat_state;
      DROP TABLE heartbeat_state;
      ALTER TABLE heartbeat_state_next RENAME TO heartbeat_state;
    `);
  } else {
    db.exec(`
      DROP INDEX IF EXISTS idx_heartbeat_state_owner;
      DROP INDEX IF EXISTS idx_heartbeat_state_shared;
    `);
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
    db.prepare('SELECT title_source FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN title_source TEXT');
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

  // Optional reporter-attached screenshot ref on support tickets (existing
  // installs predate the column in the CREATE TABLE above).
  try {
    db.prepare('SELECT screenshot_ref FROM support_tickets LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE support_tickets ADD COLUMN screenshot_ref TEXT');
  }

  // Protected reporter contact email on support tickets. Existing tickets
  // remain valid with NULL so old anonymous-compatible intake flows keep
  // working.
  try {
    db.prepare('SELECT reporter_email FROM support_tickets LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE support_tickets ADD COLUMN reporter_email TEXT');
  }

  // Read/unread state on support tickets (existing installs predate the column
  // in the CREATE TABLE above). NULL = unread; a timestamp = read.
  try {
    db.prepare('SELECT read_at FROM support_tickets LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE support_tickets ADD COLUMN read_at TEXT');
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_support_tickets_unread ON support_tickets(project_id, read_at)',
  );

  // Operator-supplied "won't do" reason on support tickets (existing installs
  // predate the column in the CREATE TABLE above).
  try {
    db.prepare('SELECT wont_do_reason FROM support_tickets LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE support_tickets ADD COLUMN wont_do_reason TEXT');
  }

  for (const [column, ddl] of [
    ['fixed_at', 'ALTER TABLE support_tickets ADD COLUMN fixed_at TEXT'],
    ['released_to_prod_at', 'ALTER TABLE support_tickets ADD COLUMN released_to_prod_at TEXT'],
    ['release_deployment_id', 'ALTER TABLE support_tickets ADD COLUMN release_deployment_id TEXT'],
    ['customer_notified_at', 'ALTER TABLE support_tickets ADD COLUMN customer_notified_at TEXT'],
  ] as const) {
    try {
      db.prepare(`SELECT ${column} FROM support_tickets LIMIT 1`).get();
    } catch {
      db.exec(ddl);
    }
  }

  // Widen the support_tickets.status CHECK to allow the 'duplicate' and
  // 'wont_do' lifecycle states. SQLite can't ALTER a CHECK in place, so when an
  // existing install's table DDL predates these states we rebuild the table
  // (preserving every row + the read/unread index) inside a transaction so a
  // partial failure can't leave the schema half-migrated.
  //
  // Detection matches the QUOTED status literal `'wont_do'` (the value inside
  // the CHECK), NOT the bare substring — the `wont_do_reason` column added just
  // above also contains "wont_do" and would otherwise mask a stale CHECK.
  {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'support_tickets'")
      .get() as { sql?: string } | undefined;
    const ddl = row?.sql ?? '';
    if (supportTicketsStatusCheckNeedsRebuild(ddl)) {
      const handle = db;
      handle.transaction(() => {
        handle.exec(`
          CREATE TABLE support_tickets_new (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'other'
              CHECK(type IN ('bug','question','feature_request','incident','other')),
            severity TEXT NOT NULL DEFAULT 'medium'
              CHECK(severity IN ('critical','high','medium','low')),
            status TEXT NOT NULL DEFAULT 'new'
              CHECK(status IN ('new','investigating','converted','closed','duplicate','wont_do')),
            subject TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            reporter TEXT,
            reporter_email TEXT,
            ai_summary TEXT,
            ai_investigation TEXT,
            ai_investigated_at TEXT,
            replay_ref TEXT,
            wont_do_reason TEXT,
            screenshot_ref TEXT,
            converted_card_id TEXT,
            read_at TEXT,
            fixed_at TEXT,
            released_to_prod_at TEXT,
            release_deployment_id TEXT,
            customer_notified_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO support_tickets_new
            (id, project_id, type, severity, status, subject, body, reporter, reporter_email,
             ai_summary, ai_investigation, ai_investigated_at, replay_ref,
             wont_do_reason, screenshot_ref, converted_card_id, read_at,
             fixed_at, released_to_prod_at, release_deployment_id, customer_notified_at,
             created_at, updated_at)
            SELECT id, project_id, type, severity, status, subject, body, reporter, reporter_email,
             ai_summary, ai_investigation, ai_investigated_at, replay_ref,
             wont_do_reason, screenshot_ref, converted_card_id, read_at,
             fixed_at, released_to_prod_at, release_deployment_id, customer_notified_at,
             created_at, updated_at
            FROM support_tickets;
          DROP TABLE support_tickets;
          ALTER TABLE support_tickets_new RENAME TO support_tickets;
          CREATE INDEX IF NOT EXISTS idx_support_tickets_project ON support_tickets(project_id);
          CREATE INDEX IF NOT EXISTS idx_support_tickets_status
            ON support_tickets(project_id, status);
          CREATE INDEX IF NOT EXISTS idx_support_tickets_unread
            ON support_tickets(project_id, read_at);
        `);
      })();
    }
  }

  // Resolve-PR sessions store the PR's head branch here so the worktree is
  // provisioned directly on that branch (commits append to the existing PR and
  // the session-end push updates it instead of opening a new PR). NULL for all
  // other sessions, which keep the default `agent-hub/<agent>/session-<id>` branch.
  try {
    db.prepare('SELECT resolve_pr_head_branch FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN resolve_pr_head_branch TEXT DEFAULT NULL');
  }

  // User-chosen existing remote branch to check the worktree out onto (general
  // form of resolve_pr_head_branch — set via the session Branch picker). NULL
  // for the default `agent-hub/<agent>/session-<id>` fresh-branch behavior.
  try {
    db.prepare('SELECT worktree_checkout_branch FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN worktree_checkout_branch TEXT DEFAULT NULL');
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

  // artifacts.storage_bucket / storage_region — persist the S3 location per row
  // so reads resolve the ORIGINAL backend even after `artifactsBucket` changes.
  // Added after the initial artifacts table shipped; NULL for local + legacy rows.
  try {
    db.prepare('SELECT storage_bucket FROM artifacts LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE artifacts ADD COLUMN storage_bucket TEXT');
  }
  try {
    db.prepare('SELECT storage_region FROM artifacts LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE artifacts ADD COLUMN storage_region TEXT');
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

  // Human-readable short card ids ("AH-123"). `kanban_boards.card_seq` is a
  // monotonic per-board counter; `kanban_cards.short_id` is the assigned
  // number. A trigger assigns short_id on insert so every card-create path
  // (board route, finalize, provisioning, support-ticket convert, …) gets one
  // without touching each call site. card_seq is only ever incremented, so a
  // deleted card never frees its number — short ids are stable and collision
  // free across deletes. Existing rows are backfilled once in created-order.
  try {
    db.exec('ALTER TABLE kanban_boards ADD COLUMN card_seq INTEGER NOT NULL DEFAULT 0');
  } catch (_e) {
    /* already exists */
  }
  try {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN short_id INTEGER');
  } catch (_e) {
    /* already exists */
  }
  // Backfill any rows that predate the column: number each board's cards in
  // (created_at, id) order. The numbering runs inside a transaction so the
  // multi-row assignment is atomic — an interruption can never leave a board
  // half-numbered. card_seq is advanced separately (and self-healingly) by the
  // unconditional reconcile below, so even an interruption between the two can't
  // leave a stale counter.
  {
    const needsBackfill = db
      .prepare('SELECT COUNT(*) AS n FROM kanban_cards WHERE short_id IS NULL')
      .get() as { n: number };
    if (needsBackfill.n > 0) {
      // Local non-null handle: the transaction callback is a nested closure, so
      // TS widens the module-level `db` back to possibly-undefined inside it.
      const database = db;
      const backfillShortIds = database.transaction(() => {
        database.exec(`
          WITH numbered AS (
            SELECT id,
                   ROW_NUMBER() OVER (
                     PARTITION BY board_id ORDER BY created_at ASC, id ASC
                   ) AS rn
            FROM kanban_cards
            WHERE short_id IS NULL
          )
          UPDATE kanban_cards
             SET short_id = (SELECT rn FROM numbered WHERE numbered.id = kanban_cards.id)
           WHERE short_id IS NULL;
        `);
      });
      backfillShortIds();
    }
  }
  // Assign-on-insert trigger (shared SQL in kanban-short-id.ts).
  db.exec(KANBAN_CARD_SHORT_ID_TRIGGER_SQL);
  // Reconcile card_seq to MAX(short_id) on every init — idempotent and
  // self-healing, so an interrupted prior backfill can't leave card_seq stale
  // and cause the trigger to mint a colliding human id. See the constant's doc.
  db.exec(KANBAN_BOARD_CARD_SEQ_RECONCILE_SQL);

  // Completion / resolution timestamps for the per-project Stats page. Adds
  // completed_at (cards, epics) + resolved_at (support tickets), the triggers
  // that maintain them on every transition, and a one-time backfill of legacy
  // rows from updated_at. Idempotent; safe on every init. See stats-completion.ts.
  installStatsCompletionTimestamps(db);

  // Persist the card-id prefix on the board (the "AH" in "AH-123"). Derived
  // once from the immutable project slug — NOT the mutable display name — so
  // renaming a project never rewrites existing, already-shared card ids. New
  // boards get it set at creation (see getOrCreateBoard); here we backfill any
  // board that predates the column.
  try {
    db.exec('ALTER TABLE kanban_boards ADD COLUMN card_prefix TEXT');
  } catch (_e) {
    /* already exists */
  }
  {
    const boardsNeedingPrefix = db
      .prepare('SELECT id, project_id FROM kanban_boards WHERE card_prefix IS NULL')
      .all() as Array<{ id: string; project_id: string }>;
    if (boardsNeedingPrefix.length > 0) {
      const setPrefix = db.prepare('UPDATE kanban_boards SET card_prefix = ? WHERE id = ?');
      const backfill = db.transaction((boards: Array<{ id: string; project_id: string }>) => {
        for (const b of boards) {
          setPrefix.run(deriveCardPrefix(b.project_id), b.id);
        }
      });
      backfill(boardsNeedingPrefix);
    }
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

  // Session mode — the "what is this session for" picker dimension (chat |
  // design). Legacy rows default to 'chat'. See server/session-mode.ts and the
  // architecture spec design-mode-fold-into-session-mode-picker.
  try {
    db.prepare('SELECT session_mode FROM sessions LIMIT 1').get();
  } catch {
    db.exec("ALTER TABLE sessions ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'chat'");
  }

  // Backfill: scheduled-task (cron) sessions are consult-only — read-only
  // log/Q&A threads, never a build/ship surface (see runCronJob in
  // heartbeat.ts). Cron sessions created before the consult tagging shipped
  // still carry the legacy default 'chat', so flip any cron-linked session
  // that isn't already consult. NOTE: this is a deliberate FORCE-OVERRIDE of
  // ANY prior mode, not just a 'chat'→'consult' default backfill — a cron
  // session that somehow ended up in e.g. 'design' is also flipped, because
  // "cron sessions are consult-only" is an invariant, not a default. Idempotent
  // + self-healing: a no-op once every row is consult, and harmless to re-run.
  // Avoids re-stamping updated_at so the sidebar ordering of historical cron
  // sessions is preserved.
  db.exec(
    "UPDATE sessions SET session_mode = 'consult' WHERE cron_id IS NOT NULL AND session_mode != 'consult'",
  );

  // Codex reasoning-effort preset: 'high' (default) | 'pro' (→ xhigh).
  // NULL on legacy rows / non-Codex sessions; resolver treats NULL as 'high'.
  try {
    db.prepare('SELECT reasoning_effort FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT DEFAULT NULL');
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

  try {
    db.prepare('SELECT finalize_automation FROM sessions LIMIT 1').get();
  } catch {
    db.exec("ALTER TABLE sessions ADD COLUMN finalize_automation TEXT NOT NULL DEFAULT 'manual'");
  }

  // Error text of the most recent turn that ended in an upstream engine/API
  // error (e.g. "API Error: The socket connection was closed unexpectedly").
  // Cleared at every turn spawn. While set, Finalize automation refuses to
  // auto-start/auto-push for the session (fail-closed against merging a
  // half-finished turn). See server/turn-error.ts.
  try {
    db.prepare('SELECT last_turn_error FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN last_turn_error TEXT DEFAULT NULL');
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

  // Monotonic per-session counter bounding code-RAG retrievals (each costs one
  // embedding call). New column — no legacy gate to migrate.
  try {
    db.prepare('SELECT code_rag_consumed FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN code_rag_consumed INTEGER NOT NULL DEFAULT 0');
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
    // Hot path: getRecentLiveSessions runs on every WS-connect handshake
    // (awaiting-input snapshot) — `deleted_at IS NULL AND updated_at >= ?
    // ORDER BY updated_at DESC LIMIT 200`. The (deleted_at, updated_at DESC)
    // composite lets SQLite seek the live rows and read them already ordered,
    // eliminating the TEMP B-TREE sort of the whole non-deleted set. It also
    // supersedes the old single-column idx_sessions_deleted_at (deleted_at is
    // the leading column), so we drop that to avoid write amplification on a
    // hot, frequently-updated table.
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_sessions_live ON sessions(deleted_at, updated_at DESC)',
    );
    db.exec('DROP INDEX IF EXISTS idx_sessions_deleted_at');
  } catch (_e) {
    /* already exists */
  }

  try {
    // stale-PR scheduled check (getStalePendingPrSessions): `changes_ready IS
    // NOT NULL AND stale_pr_notified_at IS NULL AND updated_at <= ?`. A partial
    // index over just the un-notified pending-PR sessions keeps this a tiny
    // seek instead of a full scan of the sessions table.
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sessions_stale_pr ON sessions(updated_at)
         WHERE changes_ready IS NOT NULL AND stale_pr_notified_at IS NULL`,
    );
  } catch (_e) {
    /* already exists */
  }

  try {
    // getAllCronSessions drives the cron-session list off cron_id. Most
    // sessions are not cron sessions, so a partial index over just the
    // cron-linked rows lets the join scan a few hundred rows instead of the
    // whole table.
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sessions_cron ON sessions(cron_id, updated_at DESC)
         WHERE cron_id IS NOT NULL`,
    );
  } catch (_e) {
    /* already exists */
  }

  // Always-on session lifecycle state (denormalized cache of `resolveSessionState`).
  // `recomputeSessionState` backfills this column at the production signal
  // boundaries (chat turn start/end, card auto-close, kanban move) and emits the
  // `session_state` event. Serialization still resolves the live value on read
  // via `enrichSessionForClient`, so the column is a best-effort seed/cache, not
  // the source of truth — a NULL here is always safe.
  try {
    db.prepare('SELECT state FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN state TEXT DEFAULT NULL');
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

  // Linked Design Studio design: when set, the session renders that design's
  // live canvas in a preview pane beside the chat (PUT /api/sessions/:id/
  // linked-design). NULL = no design linked. Not a FK — designs live in a
  // separate org-scoped table and may be deleted independently; the link is
  // resolved (and silently ignored when stale) at render time.
  try {
    db.prepare('SELECT linked_design_id FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN linked_design_id TEXT DEFAULT NULL');
  }

  // Consecutive automatic post-restart resume attempts not yet followed by a
  // clean turn completion. Incremented per boot in reconcileOrphanedTasks before
  // re-spawning an orphaned turn; reset to 0 when a spawned process exits
  // normally. Caps auto-resume so a crash/restart loop can't re-spawn the same
  // session forever (see MAX_RESUME_ATTEMPTS in index.ts).
  try {
    db.prepare('SELECT resume_attempts FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN resume_attempts INTEGER NOT NULL DEFAULT 0');
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

  // Persistent dedup for review-feedback dispatch. Stores the highest GitHub
  // review id we have already dispatched author feedback for, so the
  // `pull_request_review.submitted` webhook doesn't re-send the same
  // `changes_requested` feedback after a restart clears the in-memory
  // `lastDispatchedReviewId` map.
  try {
    db.prepare('SELECT last_dispatched_review_id FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN last_dispatched_review_id INTEGER DEFAULT NULL');
  }

  // Legacy dedup column for the (removed) review/CI poller's CI-failure probe.
  // No longer written now that reviews/CI are webhook-only; retained so the
  // append-only migration list stays stable on existing databases.
  try {
    db.prepare('SELECT last_dispatched_check_run_id FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec(
      'ALTER TABLE kanban_cards ADD COLUMN last_dispatched_check_run_id INTEGER DEFAULT NULL',
    );
  }

  // Legacy dedup column for the (removed) review/CI poller's inline-comment
  // probe. No longer written; retained for migration-list stability.
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

  // Set when a card's working session is closed/archived but the card had
  // already progressed (PR, finalize run, advanced column, comments, or epic)
  // so it can't be safely garbage-collected as an abandoned stub. The card is
  // kept and flagged so a human can see its originating session is gone. NULL
  // for live cards. See `server/card-orphan-cleanup.ts`.
  try {
    db.prepare('SELECT orphaned_at FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN orphaned_at TEXT DEFAULT NULL');
  }

  // Per-card auto-merge preference, captured when assigning an agent (either
  // when converting a support ticket or directly on the board). NULL = "no
  // explicit preference, use the project's githubWorkflow.autoMerge default";
  // 1 = force auto-merge ("Auto Merge"); 0 = explicitly off ("Build and
  // Push"). Carries over from a converted support ticket to the board so the
  // assign UI can pre-populate the checkbox. Consumed at assign time to pick
  // the session's finalize automation level (merge vs push).
  try {
    db.prepare('SELECT auto_merge FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN auto_merge INTEGER DEFAULT NULL');
  }

  // Durable support-ticket linkage for cards created by converting customer
  // support requests. Existing converted tickets already point at their card
  // via support_tickets.converted_card_id; backfill the card-side ids so future
  // release workflows can resolve card -> ticket without scraping markdown.
  try {
    db.prepare('SELECT support_ticket_id FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN support_ticket_id TEXT DEFAULT NULL');
  }
  try {
    db.prepare('SELECT customer_report_id FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN customer_report_id TEXT DEFAULT NULL');
  }
  db.exec(`
    UPDATE kanban_cards
       SET support_ticket_id = COALESCE(support_ticket_id, (
             SELECT st.id
               FROM support_tickets st
              WHERE st.converted_card_id = kanban_cards.id
              LIMIT 1
           )),
           customer_report_id = COALESCE(customer_report_id, (
             SELECT st.id
               FROM support_tickets st
              WHERE st.converted_card_id = kanban_cards.id
              LIMIT 1
           ))
     WHERE (support_ticket_id IS NULL OR customer_report_id IS NULL)
       AND EXISTS (
             SELECT 1
               FROM support_tickets st
              WHERE st.converted_card_id = kanban_cards.id
           )
  `);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_kanban_cards_support_ticket ON kanban_cards(support_ticket_id)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_kanban_cards_customer_report ON kanban_cards(customer_report_id)',
  );

  // Capture provenance (spec CAPTURE-PROVENANCE): the shared source triple with
  // user_todos so a card can be traced back to the Gmail message / Calendar
  // event / todo / grouped log issue it was captured from. NULL on cards created without a tracked
  // origin. The (source_type, source_id) index backs "did we already capture a
  // card from this origin?" dedup lookups.
  try {
    db.prepare('SELECT source_type FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec(
      "ALTER TABLE kanban_cards ADD COLUMN source_type TEXT CHECK(source_type IS NULL OR source_type IN ('manual','email','calendar','todo','log_issue'))",
    );
  }
  try {
    db.prepare('SELECT source_id FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN source_id TEXT');
  }
  try {
    db.prepare('SELECT source_meta FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN source_meta TEXT');
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_kanban_cards_source ON kanban_cards(source_type, source_id)',
  );

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

  // "Auto Merge" override for autonomous dispatch. When 1, sessions spawned for
  // cards under this epic start at finalize_automation `merge` ("Auto Merge")
  // regardless of the project's auto-merge config — see the dispatch path in
  // server/autonomous.ts. When 0 (default / legacy), dispatch keeps the
  // existing behavior: `merge` only when project auto-merge is on, else `push`.
  try {
    db.prepare('SELECT autonomous_send_it FROM kanban_epics LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_epics ADD COLUMN autonomous_send_it INTEGER NOT NULL DEFAULT 0');
  }

  try {
    db.prepare('SELECT labels FROM kanban_epics LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_epics ADD COLUMN labels TEXT DEFAULT NULL');
  }

  try {
    db.prepare('SELECT state FROM kanban_epics LIMIT 1').get();
  } catch {
    db.exec(
      "ALTER TABLE kanban_epics ADD COLUMN state TEXT DEFAULT NULL CHECK (state IS NULL OR state IN ('not_started', 'in_progress', 'done'))",
    );
  }

  try {
    db.prepare('SELECT assigned_user_id FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN assigned_user_id TEXT DEFAULT NULL');
  }

  try {
    db.prepare('SELECT assigned_user_id FROM kanban_epics LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_epics ADD COLUMN assigned_user_id TEXT DEFAULT NULL');
  }

  try {
    db.prepare('SELECT id FROM kanban_card_templates LIMIT 1').get();
  } catch {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kanban_card_templates (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        name TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        description TEXT,
        priority TEXT NOT NULL DEFAULT 'medium',
        labels TEXT,
        epic_id TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (board_id) REFERENCES kanban_boards(id) ON DELETE CASCADE
      )
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_kanban_card_templates_board ON kanban_card_templates(board_id)',
    );
  }

  // Phases — subgroups within an epic (Epic → Phase → Ticket hierarchy).
  try {
    db.prepare('SELECT id FROM kanban_phases LIMIT 1').get();
  } catch {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kanban_phases (
        id TEXT PRIMARY KEY,
        epic_id TEXT NOT NULL,
        board_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        -- Phases default to armed for auto-dispatch (1) and Auto Merge (1) so a
        -- multi-phase run flows on its own: each phase dispatches, its tickets
        -- auto-merge (cards reach Done), the phase "completes", and
        -- maybeAdvanceToNextPhase starts the next phase. Without auto-merge on,
        -- PRs stack/conflict, cards never reach Done, and the sequential chain
        -- stalls. The per-phase toggle is now an opt-out ("pause this phase").
        autonomous INTEGER NOT NULL DEFAULT 1,
        autonomous_interval INTEGER NOT NULL DEFAULT 5,
        autonomous_max_concurrent INTEGER NOT NULL DEFAULT 1,
        autonomous_model TEXT DEFAULT NULL,
        autonomous_enabled_by TEXT DEFAULT NULL,
        autonomous_send_it INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (epic_id) REFERENCES kanban_epics(id) ON DELETE CASCADE,
        FOREIGN KEY (board_id) REFERENCES kanban_boards(id) ON DELETE CASCADE
      )
    `);
  }

  try {
    db.prepare('SELECT autonomous_running FROM kanban_phases LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_phases ADD COLUMN autonomous_running INTEGER NOT NULL DEFAULT 0');
  }

  try {
    db.prepare('SELECT phase_id FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN phase_id TEXT DEFAULT NULL');
  }

  try {
    db.prepare('SELECT linked_epic_id FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN linked_epic_id TEXT DEFAULT NULL');
  }

  try {
    db.prepare('SELECT linked_spec_item_id FROM sessions LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN linked_spec_item_id TEXT DEFAULT NULL');
  }

  try {
    db.prepare('SELECT card_kind FROM kanban_cards LIMIT 1').get();
  } catch {
    db.exec("ALTER TABLE kanban_cards ADD COLUMN card_kind TEXT NOT NULL DEFAULT 'task'");
  }

  // Backfill spike kind for cards linked from spec items (older rows may predate card_kind).
  try {
    db.exec(`
      UPDATE kanban_cards SET card_kind = 'spike'
      WHERE COALESCE(card_kind, 'task') = 'task'
        AND id IN (
          SELECT spike_card_id FROM kanban_epic_spec_items WHERE spike_card_id IS NOT NULL
        )
    `);
  } catch {
    /* spec items table may not exist yet on very old DBs */
  }

  try {
    db.prepare('SELECT id FROM kanban_epic_spec_items LIMIT 1').get();
  } catch {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kanban_epic_spec_items (
        id TEXT PRIMARY KEY,
        epic_id TEXT NOT NULL,
        board_id TEXT NOT NULL,
        phase_id TEXT DEFAULT NULL,
        tag TEXT NOT NULL,
        title TEXT NOT NULL,
        decision TEXT DEFAULT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'chosen', 'deferred')),
        position INTEGER NOT NULL DEFAULT 0,
        spike_card_id TEXT DEFAULT NULL,
        resolved_session_id TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (epic_id) REFERENCES kanban_epics(id) ON DELETE CASCADE,
        FOREIGN KEY (board_id) REFERENCES kanban_boards(id) ON DELETE CASCADE
      )
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_kanban_spec_items_epic ON kanban_epic_spec_items(epic_id)',
    );
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

    -- Per-user, project-scoped settings. Keyed on (user_id, project_id).
    -- Today the only field is the user's preferred default Finalize
    -- automation level for new ad-hoc sessions they create in the project.
    -- user_id is the JWT-resolved user id, or '__local__' for single-tenant
    -- local mode (no authUserId). NULL default_finalize_automation means
    -- "no preference" → fall back to the global default ('manual').
    CREATE TABLE IF NOT EXISTS user_project_settings (
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      default_finalize_automation TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, project_id)
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

  // Migration: design-mode fold-in. Records the design-mode session a
  // standalone design was migrated into so the old routes can redirect and
  // the design becomes read-only. NULL until the importer runs. See
  // server/design-import.ts.
  try {
    db.exec('ALTER TABLE designs ADD COLUMN imported_session_id TEXT');
  } catch (_e) {
    /* column already exists */
  }

  // Migration: design-import concurrency lock. `import_lock` holds the
  // in-progress session id WHILE an import runs; `imported_session_id` is only
  // written once the import has FULLY committed (worktree + artifacts +
  // transcript). This separation means a concurrent importer never mistakes an
  // in-flight (or about-to-be-rolled-back) session for a completed import.
  // `import_locked_at` lets a crashed import's lock be reclaimed after a
  // timeout. See server/design-import.ts.
  try {
    db.exec('ALTER TABLE designs ADD COLUMN import_lock TEXT');
  } catch (_e) {
    /* column already exists */
  }
  try {
    db.exec('ALTER TABLE designs ADD COLUMN import_locked_at TEXT');
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

  // Code embeddings — chunk-level vectors for semantic/hybrid search over a
  // project's source tree (code-RAG). One row per (project, file, chunk). The
  // `embedding` BLOB is a raw Float32Array; `file_hash` is the SHA-1 of the file
  // content so re-indexing can skip unchanged files. `start_line`/`end_line`
  // carry the 1-based citation range. Owned by `server/code-embeddings.ts`.
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_chunks (
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      chunk_idx INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      file_hash TEXT NOT NULL,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (project_id, file_path, chunk_idx)
    );
    CREATE INDEX IF NOT EXISTS idx_code_chunks_project ON code_chunks(project_id);
    CREATE INDEX IF NOT EXISTS idx_code_chunks_file ON code_chunks(project_id, file_path);
  `);

  // FTS5 keyword index for code chunks. Rowid is kept aligned with
  // code_chunks.rowid (same trick as wiki_pages_fts) and maintained manually
  // from `server/code-embeddings.ts` inside the per-file replace transaction.
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS code_chunks_fts USING fts5(
        file_path, chunk_text, project_id UNINDEXED, chunk_idx UNINDEXED,
        content_rowid='rowid'
      );
    `);
  } catch (e: unknown) {
    console.warn('[code-rag] FTS5 creation failed (may already exist):', (e as Error).message);
  }

  // Workflow builder (MVP): definitions, steps, and execution rows. DDL is
  // shared with workflows-schema.test.ts via workflows-schema.ts.
  db.exec(WORKFLOWS_SCHEMA);

  // Background job queue (in-house, SQLite). Owned by `server/jobs/`; DDL is
  // shared with the queue's tests via jobs/schema.ts. Additive — no consumer
  // is wired yet; heartbeats/crons migrate onto it in follow-up cards.
  db.exec(JOBS_SCHEMA);

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

  // Hub-owned background shells: long-running commands that outlive the
  // per-turn CLI so they can be monitored across turns. Distinct from the
  // older `background_tasks` table (async agent prompt turns). Schema is
  // co-located with the runtime so its unit test can use an in-memory DB.
  db.exec(BACKGROUND_SHELLS_SCHEMA);

  // Deployment Module: deployments / steps / environments / approvals. Schema
  // is co-located with the deploy store so deployment-schema.test.ts can spin
  // up an in-memory DB without the full bootstrap path.
  db.exec(DEPLOYMENT_SCHEMA);
  try {
    db.exec('ALTER TABLE release_notification_outbox ADD COLUMN next_attempt_at TEXT');
  } catch (_e) {
    /* table does not exist yet or column already present */
  }
  // github_workflow deploy steps: the dispatched GitHub Actions run polled to
  // completion (run id / url / conclusion) so the Deployments page can link it.
  for (const col of ['github_run_id', 'github_run_url', 'github_conclusion']) {
    try {
      db.exec(`ALTER TABLE deployment_steps ADD COLUMN ${col} TEXT`);
    } catch (_e) {
      /* column already present */
    }
  }

  // Multi-environment management (Phase 5): operator-editable per-environment
  // runtime config (enable/disable now; triggers / schedules / notification
  // routing in later phases). Co-located schema so its store test can migrate an
  // in-memory DB in isolation.
  db.exec(DEPLOYMENT_ENV_RUNTIME_CONFIG_SCHEMA);

  // Multi-environment management (triggers phase): operator-editable per-env
  // git-event deploy triggers. Co-located schema so its store test can migrate
  // an in-memory DB in isolation.
  db.exec(DEPLOYMENT_ENV_TRIGGER_SCHEMA);

  // Multi-environment management (scheduling phase): operator-editable per-env
  // cron deploy schedules. Co-located schema so its store test can migrate an
  // in-memory DB in isolation.
  db.exec(DEPLOYMENT_ENV_SCHEDULE_SCHEMA);

  // Multi-environment management (notification-routing phase): operator-editable
  // per-env selection of which release notification types fire on a successful
  // deployment. Co-located schema so its store test can migrate an in-memory DB
  // in isolation.
  db.exec(DEPLOYMENT_ENV_NOTIFICATION_ROUTING_SCHEMA);

  // Migration: retire the legacy default "Review" kanban column. New boards
  // no longer seed it; existing boards have their Review cards folded into
  // "In Progress" and the column dropped (there is no in-UI column editor
  // yet, so boards can't be cleaned up by hand). Idempotent — no-op once a
  // board has no Review column. See migrations/collapse-review-column.ts.
  try {
    const collapsed = collapseReviewColumn(db);
    if (collapsed.columnsDeleted > 0 || collapsed.cardsMoved > 0 || collapsed.boardsSkipped > 0) {
      console.log(
        `[migration] collapse-review-column: moved ${collapsed.cardsMoved} card(s) to In Progress, ` +
          `deleted ${collapsed.columnsDeleted} Review column(s), skipped ${collapsed.boardsSkipped} board(s) ` +
          `with no In Progress target across ${collapsed.boardsScanned} board(s).`,
      );
    }
  } catch (e) {
    console.error('[migration] collapse-review-column failed:', (e as Error).message);
  }

  // Migration: arm existing kanban phases for auto-dispatch + Auto Merge once.
  // New phases default to 1/1 (see createKanbanPhase) so a multi-phase run flows
  // and merges on its own; this normalizes phases created under the old 0/0
  // defaults. Marker-guarded so a deliberately paused phase isn't re-armed on
  // every boot. See migrations/backfill-phase-autonomous-defaults.ts.
  try {
    const r = backfillPhaseAutonomousDefaults({ db, dataDir });
    if (r.ran && (r.armed > 0 || r.autoMerge > 0)) {
      console.log(
        `[migration] backfill-phase-autonomous-defaults: armed ${r.armed} phase(s) for ` +
          `auto-dispatch, enabled Auto Merge on ${r.autoMerge} phase(s).`,
      );
    }
  } catch (e) {
    console.error('[migration] backfill-phase-autonomous-defaults failed:', (e as Error).message);
  }

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
    // Artifacts (session-generated documents)
    insertArtifact: db.prepare(
      `INSERT INTO artifacts
         (id, session_id, filename, content_type, size, storage_kind, storage_key,
          storage_bucket, storage_region, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getArtifactsBySession: db.prepare(
      'SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at DESC, id DESC',
    ),
    countArtifactsBySession: db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE session_id = ?'),
    getArtifact: db.prepare('SELECT * FROM artifacts WHERE id = ?'),
    deleteArtifact: db.prepare('DELETE FROM artifacts WHERE id = ?'),
    // Session replays (record-on-error rrweb captures; blob via artifact store)
    insertSessionReplay: db.prepare(
      `INSERT INTO session_replays
         (id, project_id, duration_ms, event_count, size, uncompressed_size,
          storage_kind, storage_key, storage_bucket, storage_region,
          support_ticket_id, card_id, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getSessionReplay: db.prepare('SELECT * FROM session_replays WHERE id = ?'),
    getSessionReplaysByProject: db.prepare(
      'SELECT * FROM session_replays WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    ),
    // Most-recent replay attributed to a kanban card (convert-to-card stamps
    // session_replays.card_id). Powers the card-detail "Watch replay" surface.
    getSessionReplayByCard: db.prepare(
      'SELECT * FROM session_replays WHERE card_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    ),
    // Attribute a replay to a project / ticket / card. Two guards together:
    //   1. The WHERE clause only matches a row that is unattributed
    //      (`project_id IS NULL`) OR already owned by the caller's project
    //      (`project_id = ?`). A caller from a DIFFERENT project is a complete
    //      no-op — they cannot touch ANY field (project, ticket, or card), so a
    //      leaked `/uploads/replay-<id>.json` ref can't be used to poison or
    //      steal another project's replay, and can't pre-stamp card_id to block
    //      the rightful convert.
    //   2. COALESCE(col, ?) fills only still-NULL fields — first-write-wins
    //      within the owning project, so re-linking is idempotent and a later
    //      convert-to-card fills the NULL card_id without disturbing the rest.
    // The bound `projectId` appears twice: once for the COALESCE fill, once for
    // the WHERE ownership check.
    linkSessionReplay: db.prepare(
      `UPDATE session_replays
          SET project_id        = COALESCE(project_id, ?),
              support_ticket_id = COALESCE(support_ticket_id, ?),
              card_id           = COALESCE(card_id, ?)
        WHERE id = ?
          AND (project_id IS NULL OR project_id = ?)`,
    ),
    // Overwrite a replay's blob-derived stats after a chunked append. The blob
    // itself is replaced out-of-band (same storage_key); this just re-stamps the
    // counts/sizes/meta the read API and listing surface from.
    updateSessionReplayStats: db.prepare(
      `UPDATE session_replays
          SET duration_ms       = ?,
              event_count       = ?,
              size              = ?,
              uncompressed_size = ?,
              meta              = ?,
              updated_at        = datetime('now')
        WHERE id = ?`,
    ),
    // Restamp the blob-derived stats for a chunked append, but only while the
    // append is still ALLOWED. This is the authoritative compare-and-update the
    // chunked-append guard relies on; it enforces two things in one statement:
    //   1. Anti-tamper: the row must not be triage-linked (support_ticket_id /
    //      card_id null). A concurrent `linkSessionReplay` that finalizes the row
    //      makes this match zero rows, so a post-finalization chunk is rejected at
    //      the DB level — no append lock can cover the link write.
    //   2. Attribution integrity: the row must be unattributed OR owned by this
    //      chunk's project (`project_id IS NULL OR project_id = ?`). A foreign /
    //      anonymous chunk into an attributed capture matches zero rows.
    // `project_id = COALESCE(project_id, ?)` backfills the attribution the first
    // time a token-bearing chunk lands on an anonymous-created row. The bound
    // projectId appears twice: once for the COALESCE backfill, once for the WHERE
    // ownership guard (NULL for an anonymous chunk → only matches a NULL row).
    updateSessionReplayStatsForAppend: db.prepare(
      `UPDATE session_replays
          SET duration_ms       = ?,
              event_count       = ?,
              size              = ?,
              uncompressed_size = ?,
              meta              = ?,
              project_id        = COALESCE(project_id, ?),
              updated_at        = datetime('now')
        WHERE id = ?
          AND support_ticket_id IS NULL
          AND card_id IS NULL
          AND (project_id IS NULL OR project_id = ?)`,
    ),
    deleteSessionReplay: db.prepare('DELETE FROM session_replays WHERE id = ?'),
    // Retention GC: oldest-first batch of expired, UNLINKED replays. Linked
    // captures (support_ticket_id / card_id set) are intentional triage
    // artifacts and are excluded so retention never deletes investigation
    // history. Oldest-first so a bounded batch chips away at the longest-lived
    // backlog each sweep.
    getExpiredUnlinkedSessionReplays: db.prepare(
      `SELECT * FROM session_replays
        WHERE created_at < ?
          AND (retained_until IS NULL OR retained_until <= ?)
          AND support_ticket_id IS NULL
          AND card_id IS NULL
        ORDER BY created_at ASC
        LIMIT ?`,
    ),
    // Per-project variant for a tenant with a BASE retention override: same
    // oldest-first, unlinked, extended-retention-exempt filter, scoped to one
    // project_id so the tighter per-tenant cutoff can be applied with its own
    // per-sweep budget (batch-stall avoidance). Params: (cutoff, now, projectId,
    // limit).
    getExpiredUnlinkedSessionReplaysByProject: db.prepare(
      `SELECT * FROM session_replays
        WHERE created_at < ?
          AND (retained_until IS NULL OR retained_until <= ?)
          AND support_ticket_id IS NULL
          AND card_id IS NULL
          AND project_id = ?
        ORDER BY created_at ASC
        LIMIT ?`,
    ),
    // Flag / re-flag a replay for extended retention: stamp an absolute
    // retained_until (enable-time + window) and the enable instant. The sweeper
    // skips the row while retained_until is in the future.
    flagSessionReplayRetention: db.prepare(
      `UPDATE session_replays
          SET retained_until = ?, retention_flagged_at = ?
        WHERE id = ?`,
    ),
    // Clear an extended-retention flag: the row rejoins the default sweep.
    clearSessionReplayRetention: db.prepare(
      `UPDATE session_replays
          SET retained_until = NULL, retention_flagged_at = NULL
        WHERE id = ?`,
    ),
    // replay_playlists — named groups of saved captures (replay-playlist-store.ts).
    insertReplayPlaylist: db.prepare(
      `INSERT INTO replay_playlists (id, project_id, name, description, created_by)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    getReplayPlaylist: db.prepare('SELECT * FROM replay_playlists WHERE id = ?'),
    // item_count counts only members whose capture STILL EXISTS: the LEFT JOIN to
    // session_replays drops membership rows orphaned by a capture hard-delete
    // (COUNT(r.id) ignores the NULL side), so the LIST count matches the GET
    // count (items.length, which uses the same inner join) even before the
    // orphan membership row is reaped.
    listReplayPlaylistsByProject: db.prepare(
      `SELECT p.*, COUNT(r.id) AS item_count
         FROM replay_playlists p
         LEFT JOIN replay_playlist_items i ON i.playlist_id = p.id
         LEFT JOIN session_replays r ON r.id = i.replay_id
        WHERE p.project_id = ?
        GROUP BY p.id
        ORDER BY p.created_at DESC`,
    ),
    updateReplayPlaylist: db.prepare(
      `UPDATE replay_playlists
          SET name = ?, description = ?, updated_at = datetime('now')
        WHERE id = ?`,
    ),
    deleteReplayPlaylist: db.prepare('DELETE FROM replay_playlists WHERE id = ?'),
    // Flag / clear a playlist's extended-retention state (mirrors the per-session
    // flag columns). Params (flag): (retained_until, retention_flagged_at, id).
    flagReplayPlaylistRetention: db.prepare(
      `UPDATE replay_playlists
          SET extended_retention = 1, retained_until = ?, retention_flagged_at = ?,
              updated_at = datetime('now')
        WHERE id = ?`,
    ),
    clearReplayPlaylistRetention: db.prepare(
      `UPDATE replay_playlists
          SET extended_retention = 0, retained_until = NULL, retention_flagged_at = NULL,
              updated_at = datetime('now')
        WHERE id = ?`,
    ),
    // replay_playlist_items — membership join (replay-playlist-store.ts). Re-add is
    // idempotent (composite PK + INSERT OR IGNORE). Item read joins the capture's
    // session_replays row for dashboard metadata; missing (deleted) captures fall
    // out of the join, so a playlist never resurrects an expired capture.
    insertReplayPlaylistItem: db.prepare(
      `INSERT OR IGNORE INTO replay_playlist_items (playlist_id, replay_id, position)
       VALUES (?, ?, ?)`,
    ),
    getReplayPlaylistItem: db.prepare(
      'SELECT * FROM replay_playlist_items WHERE playlist_id = ? AND replay_id = ?',
    ),
    listReplayPlaylistItems: db.prepare(
      `SELECT i.replay_id, i.position, i.added_at, r.*
         FROM replay_playlist_items i
         JOIN session_replays r ON r.id = i.replay_id
        WHERE i.playlist_id = ?
        ORDER BY i.position ASC, i.added_at ASC`,
    ),
    // Count of members whose capture still exists (same inner-join semantics as
    // listReplayPlaylistItems) — used where only the count is needed, so the
    // metadata join isn't materialized just to read `.length`.
    countReplayPlaylistItems: db.prepare(
      `SELECT COUNT(*) AS n
         FROM replay_playlist_items i
         JOIN session_replays r ON r.id = i.replay_id
        WHERE i.playlist_id = ?`,
    ),
    listReplayPlaylistItemIds: db.prepare(
      'SELECT replay_id FROM replay_playlist_items WHERE playlist_id = ? ORDER BY position ASC',
    ),
    deleteReplayPlaylistItem: db.prepare(
      'DELETE FROM replay_playlist_items WHERE playlist_id = ? AND replay_id = ?',
    ),
    // Reap every playlist membership for a capture being hard-deleted. Called at
    // each deleteSessionReplay site (retention sweeper + replay-store delete) so
    // orphan membership rows can't accumulate unbounded. Seeks via
    // idx_replay_playlist_items_replay.
    deleteReplayPlaylistItemsByReplay: db.prepare(
      'DELETE FROM replay_playlist_items WHERE replay_id = ?',
    ),
    maxReplayPlaylistItemPosition: db.prepare(
      'SELECT COALESCE(MAX(position), -1) AS max_pos FROM replay_playlist_items WHERE playlist_id = ?',
    ),
    // rum_segments — append-only segment manifest (server/replays/segment-store.ts).
    // The INSERT is the O(1) append's row-claim: the UNIQUE (session_id, view_id,
    // index_in_view) index makes a reused slot throw instead of clobbering a
    // segment, so the claim happens BEFORE the object PUT (same pattern as
    // insertSessionReplay).
    insertRumSegment: db.prepare(
      `INSERT INTO rum_segments
         (id, session_id, view_id, project_id, index_in_view, has_full_snapshot,
          start_ts, end_ts, event_count, byte_size,
          storage_kind, storage_key, storage_bucket, storage_region)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getRumSegment: db.prepare('SELECT * FROM rum_segments WHERE id = ?'),
    // Playback manifest for a whole session: chronological across views,
    // sequential within a view (matches idx_rum_segments_session).
    listRumSegmentsBySession: db.prepare(
      `SELECT * FROM rum_segments
        WHERE session_id = ?
        ORDER BY start_ts ASC, index_in_view ASC, id ASC`,
    ),
    // Per-view manifest: strictly by append order within the view.
    listRumSegmentsByView: db.prepare(
      `SELECT * FROM rum_segments
        WHERE session_id = ? AND view_id = ?
        ORDER BY index_in_view ASC`,
    ),
    deleteRumSegment: db.prepare('DELETE FROM rum_segments WHERE id = ?'),
    deleteRumSegmentsBySession: db.prepare('DELETE FROM rum_segments WHERE session_id = ?'),
    // rum_sessions — session-grain rollup row (rum-session-store.ts). Maintained
    // incrementally as segments ingest; the dashboard lists/filters these rows.
    insertRumSession: db.prepare(
      `INSERT INTO rum_sessions
         (session_id, project_id, started_at, ended_at, time_spent,
          view_count, action_count, error_count, frustration_count,
          usr_id, usr_email, usr_name, usr_attributes,
          device_type, browser, os, geo_country)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getRumSession: db.prepare('SELECT * FROM rum_sessions WHERE session_id = ?'),
    updateRumSessionRollup: db.prepare(
      `UPDATE rum_sessions
          SET project_id = ?, started_at = ?, ended_at = ?, time_spent = ?,
              view_count = ?, action_count = ?, error_count = ?, frustration_count = ?,
              usr_id = ?, usr_email = ?, usr_name = ?, usr_attributes = ?,
              device_type = ?, browser = ?, os = ?, geo_country = ?,
              updated_at = datetime('now')
        WHERE session_id = ?`,
    ),
    listRumSessionsByProject: db.prepare(
      `SELECT * FROM rum_sessions
        WHERE project_id = ?
        ORDER BY started_at DESC, session_id DESC
        LIMIT ?`,
    ),
    deleteRumSession: db.prepare('DELETE FROM rum_sessions WHERE session_id = ?'),
    // Index-row TTL reconciliation for segmented captures
    // (server/replays/rum-segment-retention-sweeper.ts). Once the S3-native
    // lifecycle rule (T61) expires the `rum/` bytes, these index rows point at
    // gone objects and must be reaped. `updated_at` bumps on every segment
    // rollup, so it is the wall-clock of the session's NEWEST segment: a session
    // whose updated_at is older than the retention cutoff has ALL its segment
    // objects past expiry, so reaping it can never drop an index row whose bytes
    // still live. Oldest-first so a bounded batch chips at the longest-lived
    // backlog each sweep.
    getExpiredRumSessions: db.prepare(
      `SELECT * FROM rum_sessions
        WHERE updated_at < ?
        ORDER BY updated_at ASC
        LIMIT ?`,
    ),
    // Per-project variant for a tenant with a BASE retention override: the tighter
    // per-tenant cutoff is applied to just this project's sessions, with its own
    // per-sweep budget so one heavy tenant can't stall another's window. Params:
    // (cutoff, projectId, limit).
    getExpiredRumSessionsByProject: db.prepare(
      `SELECT * FROM rum_sessions
        WHERE updated_at < ?
          AND project_id = ?
        ORDER BY updated_at ASC
        LIMIT ?`,
    ),
    // Conditional session-row delete used by the sweep AFTER byte reclamation.
    // Re-asserting `updated_at < ?` closes a TOCTOU race: byte reclamation awaits
    // (yields the loop), so a late ingest for the same session can append a new
    // segment and bump `updated_at` in between. Guarding the delete on the cutoff
    // keeps a now-active session (and its fresh, un-reclaimed segment) instead of
    // dropping the row out from under it.
    deleteExpiredRumSession: db.prepare(
      `DELETE FROM rum_sessions WHERE session_id = ? AND updated_at < ?`,
    ),
    // Orphan-segment reconciliation: rum_segments rows whose session-grain row is
    // already gone (a best-effort rollup that threw during ingest, or a partial
    // prior sweep) never get reaped by the session-keyed pass. Reap those whose
    // own created_at is past the cutoff so they can't accumulate.
    getExpiredOrphanRumSegments: db.prepare(
      `SELECT s.* FROM rum_segments s
        WHERE s.created_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM rum_sessions rs WHERE rs.session_id = s.session_id
          )
        ORDER BY s.created_at ASC
        LIMIT ?`,
    ),
    // Per-project variant for a tenant with a BASE retention override: orphan
    // segments (session-grain row already gone) scoped to one project_id so the
    // tighter cutoff reaps them on the tenant's own schedule. Params: (cutoff,
    // projectId, limit).
    getExpiredOrphanRumSegmentsByProject: db.prepare(
      `SELECT s.* FROM rum_segments s
        WHERE s.created_at < ?
          AND s.project_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM rum_sessions rs WHERE rs.session_id = s.session_id
          )
        ORDER BY s.created_at ASC
        LIMIT ?`,
    ),
    // Per-project RUM ingest clients (rum-clients-store.ts)
    insertRumClient: db.prepare(
      `INSERT INTO project_rum_clients (id, project_id, name, token_hash, prefix, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    getRumClient: db.prepare('SELECT * FROM project_rum_clients WHERE id = ?'),
    // Verify path: O(1) lookup on the indexed prefix + the UNIQUE hash. The
    // revoked filter happens in the store so a revoked match is distinguishable.
    getRumClientByPrefixHash: db.prepare(
      'SELECT * FROM project_rum_clients WHERE prefix = ? AND token_hash = ?',
    ),
    listRumClientsByProject: db.prepare(
      `SELECT * FROM project_rum_clients
        WHERE project_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC, id DESC`,
    ),
    // Scoped soft-delete: only revokes a row owned by the caller's project and
    // not already revoked, so a clientId from another project is a no-op.
    revokeRumClient: db.prepare(
      `UPDATE project_rum_clients SET revoked_at = datetime('now')
        WHERE id = ? AND project_id = ? AND revoked_at IS NULL`,
    ),
    touchRumClientLastUsed: db.prepare(
      "UPDATE project_rum_clients SET last_used_at = datetime('now') WHERE id = ?",
    ),
    // Deployment Module (deploy/deployment-store.ts)
    insertDeployment: db.prepare(
      `INSERT INTO deployments
         (id, project_id, environment, ref, status, trigger, triggered_by,
          source_deployment_id, runner_job_id, meta)
       VALUES (@id, @project_id, @environment, @ref, @status, @trigger, @triggered_by,
          @source_deployment_id, @runner_job_id, @meta)`,
    ),
    getDeployment: db.prepare('SELECT * FROM deployments WHERE id = ?'),
    // rowid tiebreak (monotonic insertion order): created_at has 1-second
    // resolution, so same-second rows must fall back to insertion order, not
    // the random UUID id, for a stable newest-first history.
    listDeploymentsByProject: db.prepare(
      `SELECT * FROM deployments
        WHERE project_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ? OFFSET ?`,
    ),
    listDeploymentsByEnvironment: db.prepare(
      `SELECT * FROM deployments
        WHERE project_id = ? AND environment = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ? OFFSET ?`,
    ),
    // Stamps started_at on the first transition into a non-pending state and
    // completed_at on a terminal state; updated_at always bumps.
    updateDeploymentStatus: db.prepare(
      `UPDATE deployments
          SET status = @status,
              error = @error,
              started_at = COALESCE(started_at,
                CASE WHEN @status = 'running' THEN datetime('now') ELSE NULL END),
              completed_at = CASE
                WHEN @status IN ('success', 'error', 'cancelled') THEN datetime('now')
                ELSE completed_at END,
              updated_at = datetime('now')
        WHERE id = @id`,
    ),
    setDeploymentRunnerJob: db.prepare(
      "UPDATE deployments SET runner_job_id = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    setDeploymentMeta: db.prepare(
      "UPDATE deployments SET meta = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    insertDeploymentStep: db.prepare(
      `INSERT INTO deployment_steps (id, deployment_id, name, step_order, status)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    getDeploymentStep: db.prepare('SELECT * FROM deployment_steps WHERE id = ?'),
    listDeploymentSteps: db.prepare(
      'SELECT * FROM deployment_steps WHERE deployment_id = ? ORDER BY step_order ASC, rowid ASC',
    ),
    updateDeploymentStepStatus: db.prepare(
      `UPDATE deployment_steps
          SET status = @status,
              exit_code = @exit_code,
              error = @error,
              started_at = COALESCE(started_at,
                CASE WHEN @status != 'pending' THEN datetime('now') ELSE NULL END),
              completed_at = CASE
                WHEN @status IN ('success', 'error', 'skipped', 'cancelled') THEN datetime('now')
                ELSE completed_at END
        WHERE id = @id`,
    ),
    setDeploymentStepGithubRun: db.prepare(
      `UPDATE deployment_steps
          SET github_run_id = @github_run_id,
              github_run_url = @github_run_url,
              github_conclusion = @github_conclusion
        WHERE id = @id`,
    ),
    // Idempotent registration of an environment row (created on first deploy or
    // first config sync). Leaves live-ref / lock columns untouched on conflict.
    upsertDeploymentEnvironment: db.prepare(
      `INSERT INTO deployment_environments (id, project_id, name)
       VALUES (?, ?, ?)
       ON CONFLICT(project_id, name) DO NOTHING`,
    ),
    getDeploymentEnvironment: db.prepare(
      'SELECT * FROM deployment_environments WHERE project_id = ? AND name = ?',
    ),
    listDeploymentEnvironments: db.prepare(
      'SELECT * FROM deployment_environments WHERE project_id = ? ORDER BY name ASC',
    ),
    // Multi-environment management (Phase 5): per-environment runtime config.
    // Upsert applies operator edits (enable/disable, meta) without clobbering
    // created_at; a fresh row defaults enabled=1.
    upsertDeploymentEnvRuntimeConfig: db.prepare(
      `INSERT INTO deployment_env_runtime_config (id, project_id, environment_name, enabled, meta)
       VALUES (@id, @project_id, @environment_name, @enabled, @meta)
       ON CONFLICT(project_id, environment_name) DO UPDATE SET
         enabled = excluded.enabled,
         meta = excluded.meta,
         updated_at = datetime('now')`,
    ),
    getDeploymentEnvRuntimeConfig: db.prepare(
      'SELECT * FROM deployment_env_runtime_config WHERE project_id = ? AND environment_name = ?',
    ),
    listDeploymentEnvRuntimeConfig: db.prepare(
      'SELECT * FROM deployment_env_runtime_config WHERE project_id = ? ORDER BY environment_name ASC',
    ),
    deleteDeploymentEnvRuntimeConfig: db.prepare(
      'DELETE FROM deployment_env_runtime_config WHERE project_id = ? AND environment_name = ?',
    ),
    // Per-environment git-event deploy triggers (triggers phase). UNIQUE(project,
    // env, event, pattern) rejects duplicate identical triggers. Update never
    // touches created_at.
    insertDeploymentEnvTrigger: db.prepare(
      `INSERT INTO deployment_env_trigger
        (id, project_id, environment_name, event, branch_pattern, enabled, meta)
       VALUES (@id, @project_id, @environment_name, @event, @branch_pattern, @enabled, @meta)`,
    ),
    updateDeploymentEnvTrigger: db.prepare(
      `UPDATE deployment_env_trigger
       SET event = @event,
           branch_pattern = @branch_pattern,
           enabled = @enabled,
           meta = @meta,
           updated_at = datetime('now')
       WHERE project_id = @project_id AND id = @id`,
    ),
    getDeploymentEnvTrigger: db.prepare(
      'SELECT * FROM deployment_env_trigger WHERE project_id = ? AND id = ?',
    ),
    listDeploymentEnvTriggersForProject: db.prepare(
      `SELECT * FROM deployment_env_trigger WHERE project_id = ?
       ORDER BY environment_name ASC, event ASC, branch_pattern ASC`,
    ),
    listDeploymentEnvTriggersForEnvironment: db.prepare(
      `SELECT * FROM deployment_env_trigger WHERE project_id = ? AND environment_name = ?
       ORDER BY event ASC, branch_pattern ASC`,
    ),
    listEnabledDeploymentEnvTriggersForEvent: db.prepare(
      `SELECT * FROM deployment_env_trigger
       WHERE project_id = ? AND event = ? AND enabled = 1
       ORDER BY environment_name ASC, branch_pattern ASC`,
    ),
    deleteDeploymentEnvTrigger: db.prepare(
      'DELETE FROM deployment_env_trigger WHERE project_id = ? AND id = ?',
    ),
    // Per-environment cron deploy schedules (scheduling phase). UNIQUE(project,
    // env, ref, cron) rejects duplicate identical schedules. owner_user_id is set
    // once at create time and never touched by update. Update never touches
    // created_at.
    insertDeploymentEnvSchedule: db.prepare(
      `INSERT INTO deployment_env_schedule
        (id, project_id, environment_name, ref, cron, timezone, owner_user_id, enabled, meta)
       VALUES (@id, @project_id, @environment_name, @ref, @cron, @timezone, @owner_user_id, @enabled, @meta)`,
    ),
    updateDeploymentEnvSchedule: db.prepare(
      `UPDATE deployment_env_schedule
       SET ref = @ref,
           cron = @cron,
           timezone = @timezone,
           enabled = @enabled,
           meta = @meta,
           updated_at = datetime('now')
       WHERE project_id = @project_id AND id = @id`,
    ),
    getDeploymentEnvSchedule: db.prepare(
      'SELECT * FROM deployment_env_schedule WHERE project_id = ? AND id = ?',
    ),
    listDeploymentEnvSchedulesForProject: db.prepare(
      `SELECT * FROM deployment_env_schedule WHERE project_id = ?
       ORDER BY environment_name ASC, ref ASC, cron ASC`,
    ),
    listDeploymentEnvSchedulesForEnvironment: db.prepare(
      `SELECT * FROM deployment_env_schedule WHERE project_id = ? AND environment_name = ?
       ORDER BY ref ASC, cron ASC`,
    ),
    listEnabledDeploymentEnvSchedules: db.prepare(
      `SELECT * FROM deployment_env_schedule WHERE enabled = 1
       ORDER BY project_id ASC, environment_name ASC, ref ASC, cron ASC`,
    ),
    deleteDeploymentEnvSchedule: db.prepare(
      'DELETE FROM deployment_env_schedule WHERE project_id = ? AND id = ?',
    ),
    // Per-environment notification routing (notification-routing phase). At most
    // one row per (project, env); upsert applies operator edits without
    // clobbering created_at.
    upsertDeploymentEnvNotificationRouting: db.prepare(
      `INSERT INTO deployment_env_notification_routing
        (id, project_id, environment_name, ticket_release_enabled, release_digest_enabled, meta)
       VALUES (@id, @project_id, @environment_name, @ticket_release_enabled, @release_digest_enabled, @meta)
       ON CONFLICT(project_id, environment_name) DO UPDATE SET
         ticket_release_enabled = excluded.ticket_release_enabled,
         release_digest_enabled = excluded.release_digest_enabled,
         meta = excluded.meta,
         updated_at = datetime('now')`,
    ),
    getDeploymentEnvNotificationRouting: db.prepare(
      'SELECT * FROM deployment_env_notification_routing WHERE project_id = ? AND environment_name = ?',
    ),
    listDeploymentEnvNotificationRouting: db.prepare(
      `SELECT * FROM deployment_env_notification_routing WHERE project_id = ?
       ORDER BY environment_name ASC`,
    ),
    deleteDeploymentEnvNotificationRouting: db.prepare(
      'DELETE FROM deployment_env_notification_routing WHERE project_id = ? AND environment_name = ?',
    ),
    // Concurrency lock acquire: only succeeds (changes=1) when no deploy is
    // in-flight for this env. A non-zero result means the lock is held → 409.
    acquireDeploymentEnvironmentLock: db.prepare(
      `UPDATE deployment_environments
          SET active_deployment_id = @deployment_id, updated_at = datetime('now')
        WHERE project_id = @project_id AND name = @name
          AND active_deployment_id IS NULL`,
    ),
    // Release clears the lock only if WE hold it (defends against clearing a
    // lock acquired by a newer deploy).
    releaseDeploymentEnvironmentLock: db.prepare(
      `UPDATE deployment_environments
          SET active_deployment_id = NULL, updated_at = datetime('now')
        WHERE project_id = @project_id AND name = @name
          AND active_deployment_id = @deployment_id`,
    ),
    setDeploymentEnvironmentCurrentRef: db.prepare(
      `UPDATE deployment_environments
          SET current_ref = @current_ref,
              current_deployment_id = @current_deployment_id,
              updated_at = datetime('now')
        WHERE project_id = @project_id AND name = @name`,
    ),
    claimDeploymentForApproval: db.prepare(
      `UPDATE deployments
          SET status = 'running',
              error = NULL,
              started_at = COALESCE(started_at, datetime('now')),
              updated_at = datetime('now')
        WHERE id = @id AND status = 'awaiting_approval'`,
    ),
    insertDeploymentApproval: db.prepare(
      `INSERT INTO deployment_approvals
         (id, deployment_id, approver_user_id, approver_role, decision, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    listDeploymentApprovals: db.prepare(
      'SELECT * FROM deployment_approvals WHERE deployment_id = ? ORDER BY created_at ASC, rowid ASC',
    ),
    getScopedDeploymentReleaseCard: db.prepare(
      `SELECT d.project_id,
              c.id AS card_id,
              c.support_ticket_id
         FROM deployments d
         JOIN kanban_cards c ON c.id = ?
         JOIN kanban_boards b ON b.id = c.board_id
        WHERE d.id = ?
          AND b.project_id = d.project_id`,
    ),
    getScopedDeploymentReleaseTicket: db.prepare(
      `SELECT st.id
         FROM support_tickets st
         JOIN deployments d ON d.project_id = st.project_id
        WHERE d.id = ?
          AND st.id = ?`,
    ),
    insertDeploymentReleaseItem: db.prepare(
      `INSERT INTO deployment_release_items
         (id, deployment_id, card_id, support_ticket_id, source, inclusion_status,
          operator_adjusted_by, operator_adjustment_note, operator_adjustment_meta,
          operator_adjusted_at)
       VALUES (@id, @deployment_id, @card_id, @support_ticket_id, @source, @inclusion_status,
          @operator_adjusted_by, @operator_adjustment_note, @operator_adjustment_meta,
          @operator_adjusted_at)
       ON CONFLICT(deployment_id, card_id) DO NOTHING`,
    ),
    getDeploymentReleaseItem: db.prepare('SELECT * FROM deployment_release_items WHERE id = ?'),
    getDeploymentReleaseItemByDeploymentCard: db.prepare(
      'SELECT * FROM deployment_release_items WHERE deployment_id = ? AND card_id = ?',
    ),
    updateDeploymentReleaseItemTicket: db.prepare(
      `UPDATE deployment_release_items
          SET support_ticket_id = COALESCE(support_ticket_id, ?),
              updated_at = datetime('now')
        WHERE deployment_id = ? AND card_id = ?`,
    ),
    updateDeploymentReleaseItemAdjustment: db.prepare(
      `UPDATE deployment_release_items
          SET source = @source,
              inclusion_status = @inclusion_status,
              operator_adjusted_by = @operator_adjusted_by,
              operator_adjustment_note = @operator_adjustment_note,
              operator_adjustment_meta = @operator_adjustment_meta,
              operator_adjusted_at = COALESCE(@operator_adjusted_at, datetime('now')),
              updated_at = datetime('now')
        WHERE deployment_id = @deployment_id AND card_id = @card_id`,
    ),
    listDeploymentReleaseItems: db.prepare(
      `SELECT * FROM deployment_release_items
        WHERE deployment_id = ?
        ORDER BY created_at ASC, rowid ASC`,
    ),
    listDeploymentReleaseItemsWithContext: db.prepare(
      `SELECT ri.*,
              c.title AS card_title,
              c.short_id AS card_short_id,
              c.priority AS card_priority,
              c.description AS card_description,
              c.labels AS card_labels,
              col.name AS card_column_name,
              st.subject AS support_ticket_subject,
              st.ai_summary AS support_ticket_summary,
              st.status AS support_ticket_status,
              st.type AS support_ticket_type,
              st.reporter_email AS support_ticket_reporter_email,
              st.fixed_at AS support_ticket_fixed_at,
              st.released_to_prod_at AS support_ticket_released_to_prod_at,
              st.customer_notified_at AS support_ticket_customer_notified_at
         FROM deployment_release_items ri
         JOIN kanban_cards c
           ON c.id = ri.card_id
         LEFT JOIN kanban_columns col
           ON col.id = c.column_id
         LEFT JOIN support_tickets st
           ON st.id = ri.support_ticket_id
        WHERE ri.deployment_id = ?
        ORDER BY ri.created_at ASC, ri.rowid ASC`,
    ),
    insertReleaseNotificationOutbox: db.prepare(
      `INSERT INTO release_notification_outbox
         (id, project_id, deployment_id, release_item_id, support_ticket_id,
          notification_type, idempotency_key, recipient_email, subject, body_text)
       VALUES (@id, @project_id, @deployment_id, @release_item_id, @support_ticket_id,
          @notification_type, @idempotency_key, @recipient_email, @subject, @body_text)
       ON CONFLICT(idempotency_key) DO NOTHING`,
    ),
    getReleaseNotificationOutboxById: db.prepare(
      'SELECT * FROM release_notification_outbox WHERE id = ?',
    ),
    getReleaseNotificationOutboxByKey: db.prepare(
      'SELECT * FROM release_notification_outbox WHERE idempotency_key = ?',
    ),
    listReleaseNotificationOutboxByDeployment: db.prepare(
      `SELECT * FROM release_notification_outbox
        WHERE deployment_id = ?
        ORDER BY created_at ASC, rowid ASC`,
    ),
    listReleaseNotificationOutboxBySupportTicket: db.prepare(
      `SELECT * FROM release_notification_outbox
        WHERE support_ticket_id = ?
        ORDER BY created_at ASC, rowid ASC`,
    ),
    listRetryEligibleReleaseNotificationOutbox: db.prepare(
      `SELECT * FROM release_notification_outbox
        WHERE sent_at IS NULL
          AND attempts < ?
          AND (
            status = 'pending'
            OR (
              status = 'error'
              AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
            )
            OR (status = 'sending' AND updated_at <= datetime('now', '-15 minutes'))
          )
        ORDER BY created_at ASC, rowid ASC
        LIMIT ?`,
    ),
    retryReleaseNotificationOutbox: db.prepare(
      `UPDATE release_notification_outbox
          SET status = 'pending',
              attempts = CASE WHEN attempts >= ? THEN ? ELSE attempts END,
              next_attempt_at = NULL,
              last_error = NULL,
              updated_at = datetime('now')
        WHERE id = ?
          AND sent_at IS NULL
          AND status = 'error'`,
    ),
    markReleaseNotificationOutboxSending: db.prepare(
      `UPDATE release_notification_outbox
          SET status = 'sending',
              attempts = attempts + 1,
              next_attempt_at = NULL,
              updated_at = datetime('now')
        WHERE id = ?
          AND sent_at IS NULL
          AND (
            status IN ('pending', 'error')
            OR (status = 'sending' AND updated_at <= datetime('now', '-15 minutes'))
          )`,
    ),
    markReleaseNotificationOutboxSent: db.prepare(
      `UPDATE release_notification_outbox
          SET status = 'sent',
              sent_at = datetime('now'),
              next_attempt_at = NULL,
              last_error = NULL,
              updated_at = datetime('now')
        WHERE id = ?
          AND status = 'sending'
          AND sent_at IS NULL
          AND attempts = ?`,
    ),
    markReleaseNotificationOutboxError: db.prepare(
      `UPDATE release_notification_outbox
          SET status = 'error',
              next_attempt_at = ?,
              last_error = ?,
              updated_at = datetime('now')
        WHERE id = ?
          AND sent_at IS NULL
          AND status != 'sent'`,
    ),
    markReleaseNotificationOutboxDeliveryError: db.prepare(
      `UPDATE release_notification_outbox
          SET status = 'error',
              next_attempt_at = ?,
              last_error = ?,
              updated_at = datetime('now')
        WHERE id = ?
          AND status = 'sending'
          AND sent_at IS NULL
          AND attempts = ?`,
    ),
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
      "UPDATE sessions SET name = ?, title_source = 'manual', updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionNameWithTitleSource: db.prepare(
      "UPDATE sessions SET name = ?, title_source = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateAutoSessionNameIfCurrent: db.prepare(
      "UPDATE sessions SET name = ?, title_source = 'auto', updated_at = datetime('now') WHERE id = ? AND name = ? AND title_source = 'auto'",
    ),
    updateSessionMaxTurns: db.prepare(
      "UPDATE sessions SET max_turns = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionLinkedDesign: db.prepare(
      "UPDATE sessions SET linked_design_id = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionLinkedEpic: db.prepare(
      "UPDATE sessions SET linked_epic_id = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionLinkedSpecItem: db.prepare(
      "UPDATE sessions SET linked_spec_item_id = ?, updated_at = datetime('now') WHERE id = ?",
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
    updateSessionFinalizeAutomation: db.prepare(
      "UPDATE sessions SET finalize_automation = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    getUserProjectSettings: db.prepare(
      'SELECT * FROM user_project_settings WHERE user_id = ? AND project_id = ?',
    ),
    upsertUserProjectDefaultFinalizeAutomation: db.prepare(
      `INSERT INTO user_project_settings (user_id, project_id, default_finalize_automation, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, project_id) DO UPDATE SET
         default_finalize_automation = excluded.default_finalize_automation,
         updated_at = datetime('now')`,
    ),
    // Derived state cache — intentionally does NOT touch `updated_at` so that
    // frequent signal-boundary recomputes don't churn the session sort order.
    updateSessionState: db.prepare('UPDATE sessions SET state = ? WHERE id = ?'),
    // Turn-error flag — intentionally does NOT touch `updated_at` (set/cleared
    // around every spawn; must not churn the session sort order).
    updateSessionLastTurnError: db.prepare('UPDATE sessions SET last_turn_error = ? WHERE id = ?'),
    // Post-restart resume-attempt counter — intentionally does NOT touch
    // `updated_at` (boot-time / process-exit bookkeeping must not churn sort).
    incrementSessionResumeAttempts: db.prepare(
      'UPDATE sessions SET resume_attempts = resume_attempts + 1 WHERE id = ?',
    ),
    resetSessionResumeAttempts: db.prepare(
      'UPDATE sessions SET resume_attempts = 0 WHERE id = ? AND resume_attempts != 0',
    ),
    updateSessionWorktree: db.prepare(
      "UPDATE sessions SET use_worktree = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionWorktreePath: db.prepare(
      "UPDATE sessions SET worktree_path = ?, worktree_branch = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    // Resolve-PR sessions: record the PR head branch so `ensureSessionWorkspace`
    // provisions the worktree directly on it (pushes update the existing PR).
    setSessionResolvePrHeadBranch: db.prepare(
      "UPDATE sessions SET resolve_pr_head_branch = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    // Session Branch picker: record the user-chosen existing branch so
    // `ensureSessionWorkspace` checks the worktree out onto it (pushes update
    // that branch's PR). NULL clears the choice back to the default fresh branch.
    setSessionWorktreeCheckoutBranch: db.prepare(
      "UPDATE sessions SET worktree_checkout_branch = ?, updated_at = datetime('now') WHERE id = ?",
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
    updateSessionMode: db.prepare(
      "UPDATE sessions SET session_mode = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateSessionReasoningEffort: db.prepare(
      "UPDATE sessions SET reasoning_effort = ?, updated_at = datetime('now') WHERE id = ?",
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
    updateSessionCodeRagConsumed: db.prepare(
      "UPDATE sessions SET code_rag_consumed = ?, updated_at = datetime('now') WHERE id = ?",
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
    // Same columns as addMessage but with an explicit trailing created_at, so
    // the Design Studio importer can replay design_messages with their
    // original timestamps preserved (transcript order survives the import).
    addMessageWithCreatedAt: db.prepare(
      'INSERT INTO messages (id, session_id, role, content, engine, model, attachments, metadata, agent_id, agent_name, agent_color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    // `rowid` (monotonic insert order) is a deterministic tie-breaker so
    // messages sharing the same second-precision `created_at` keep insertion
    // order instead of an arbitrary one. This matters for replayed transcripts
    // (Design Studio import) and any rapidly-created same-second messages.
    getMessages: db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC',
    ),
    // Keyset pagination by rowid (monotonic insert order, stable under
    // same-second created_at collisions). Newest page first; older pages key
    // off the oldest loaded message's id (resolved to its rowid via subquery).
    getMessagesPageLatest: db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT ?',
    ),
    // The cursor subquery is scoped by session_id too: a `before` id that
    // belongs to another session (or is unknown) resolves to NULL, making
    // `rowid < NULL` match nothing — the foreign/invalid cursor is treated as
    // an empty page rather than leaking an arbitrary window of this session.
    getMessagesPageBeforeId: db.prepare(
      'SELECT * FROM messages WHERE session_id = ? AND rowid < (SELECT rowid FROM messages WHERE id = ? AND session_id = ?) ORDER BY rowid DESC LIMIT ?',
    ),
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
      'INSERT INTO crons (name, schedule, timezone, prompt, cwd, enabled, project_id, timeout_ms, notify_on_run, model, skill_principal_agent_id, engine, owner_user_id, shared) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    updateCron: db.prepare(
      'UPDATE crons SET name = ?, schedule = ?, timezone = ?, prompt = ?, cwd = ?, enabled = ?, project_id = ?, timeout_ms = ?, notify_on_run = ?, model = ?, skill_principal_agent_id = ?, engine = ?, shared = ? WHERE id = ?',
    ),
    backfillCronOwners: db.prepare(
      'UPDATE crons SET owner_user_id = ? WHERE owner_user_id IS NULL',
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
    // Clears a STALE `imported_session_id` (a recorded session that was later
    // deleted) so a re-import can proceed. CAS on the observed value: if a
    // concurrent importer already swapped in a fresh id, this no-ops
    // (changes === 0) and the caller defers to that import.
    clearStaleImportedSession: db.prepare(
      "UPDATE designs SET imported_session_id = NULL, updated_at = datetime('now') WHERE id = ? AND imported_session_id IS ?",
    ),
    // Acquire the import lock. Succeeds (changes === 1) only when the design is
    // NOT already imported AND no live lock is held — a lock older than the
    // stale window (passed as the SQLite datetime modifier, e.g.
    // '-300 seconds') is reclaimable so a crashed import doesn't wedge the row
    // forever. The in-progress session id is stored in `import_lock`;
    // `imported_session_id` stays NULL until the import fully commits.
    acquireDesignImportLock: db.prepare(
      "UPDATE designs SET import_lock = ?, import_locked_at = datetime('now'), updated_at = datetime('now') " +
        "WHERE id = ? AND imported_session_id IS NULL AND (import_lock IS NULL OR import_locked_at < datetime('now', ?))",
    ),
    // Commit the import: publish `imported_session_id` and drop the lock, but
    // only if THIS caller still holds it (import_lock = our session id).
    completeDesignImport: db.prepare(
      "UPDATE designs SET imported_session_id = ?, import_lock = NULL, import_locked_at = NULL, updated_at = datetime('now') " +
        'WHERE id = ? AND import_lock = ?',
    ),
    // Release the lock without publishing (failure rollback). Scoped to the
    // holder so a late failure can't clobber a newer importer's lock.
    releaseDesignImportLock: db.prepare(
      "UPDATE designs SET import_lock = NULL, import_locked_at = NULL, updated_at = datetime('now') " +
        'WHERE id = ? AND import_lock = ?',
    ),

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
    // `rowid` tie-breaks same-second messages so the source transcript order is
    // deterministic — the importer relies on this to replay in original order.
    listDesignMessages: db.prepare(
      'SELECT * FROM design_messages WHERE design_id = ? ORDER BY created_at ASC, rowid ASC',
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
      // `c.project_id as project_id` lets the client group scheduled-task rows
      // under their owning project in the sidebar. The sessions table has no
      // project_id column of its own (cron sessions use the `_cron` pseudo
      // agent), so the cron row is the authoritative source of the project.
      // `c.shared as cron_shared` lets the sidebar list route apply the same
      // shared-cron visibility as GET /api/crons — a shared cron is listed for
      // every org member, not just its owner.
      `SELECT s.*, c.name as cron_name, c.schedule as cron_schedule, c.project_id as project_id, c.shared as cron_shared
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
    // NOTE: 4 positional params (id, project_id, name, card_prefix). If you
    // change this arity, update EVERY `.run()` call site in the same commit —
    // they are positional and unchecked at compile time. Current callers:
    // server/routes/board.ts (getOrCreateBoard), server/routes/config.ts
    // (import-board), plus the test fixtures in routes/pulls-native.test.ts and
    // test/handoff-integration.test.ts.
    createKanbanBoard: db.prepare(
      'INSERT INTO kanban_boards (id, project_id, name, card_prefix) VALUES (?, ?, ?, ?)',
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
    // Keyset pagination: first page (no cursor) and after-cursor page, both
    // ordered by (position, id) so a `(position, id)` cursor resumes at a
    // stable point even when cards are reordered mid-scroll. The trailing `?`
    // binds LIMIT (callers pass limit+1 to detect whether a next page exists).
    getKanbanCardsByColumnPageFirst: db.prepare(
      'SELECT * FROM kanban_cards WHERE column_id = ? ORDER BY position ASC, id ASC LIMIT ?',
    ),
    getKanbanCardsByColumnPageAfter: db.prepare(
      `SELECT * FROM kanban_cards
         WHERE column_id = ?
           AND (position > ? OR (position = ? AND id > ?))
         ORDER BY position ASC, id ASC
         LIMIT ?`,
    ),
    countKanbanCardsByColumn: db.prepare(
      'SELECT COUNT(*) AS n FROM kanban_cards WHERE column_id = ?',
    ),
    getKanbanCard: db.prepare('SELECT * FROM kanban_cards WHERE id = ?'),
    createKanbanCard: db.prepare(
      `INSERT INTO kanban_cards (id, column_id, board_id, title, description, priority, assignee, labels, session_id, github_issue_url, created_by, assign_model, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    linkKanbanCardSupportTicket: db.prepare(
      `UPDATE kanban_cards
          SET support_ticket_id = ?, customer_report_id = ?, updated_at = datetime('now')
        WHERE id = ?`,
    ),
    // Compare-and-swap claim of a card's support-ticket back-link, used by the
    // "link ticket to existing card" path. The claim is only stamped when the
    // card is still on the target board AND unclaimed (or already claimed by
    // this same ticket). Guarding the WRITE itself — not a preceding read — is
    // what makes the claim race-safe across processes: two concurrent linkers
    // serialize on the SQLite write lock and the loser's UPDATE matches 0 rows
    // (checked via `changes`) instead of clobbering the winner's provenance.
    // Params: (supportTicketId, customerReportId, cardId, boardId, supportTicketId).
    claimKanbanCardForSupportTicket: db.prepare(
      `UPDATE kanban_cards
          SET support_ticket_id = ?, customer_report_id = ?, updated_at = datetime('now')
        WHERE id = ?
          AND board_id = ?
          AND (support_ticket_id IS NULL OR support_ticket_id = ?)`,
    ),
    // Stamp capture provenance on a card after create (spec CAPTURE-PROVENANCE).
    // Kept out of createKanbanCard's positional INSERT so the ~8 create callers
    // don't all have to thread three more args; the create/convert paths that
    // carry an origin call this immediately after insert.
    setKanbanCardProvenance: db.prepare(
      `UPDATE kanban_cards
          SET source_type = ?, source_id = ?, source_meta = ?, updated_at = datetime('now')
        WHERE id = ?`,
    ),
    getLinkedSupportTicketsForBoard: db.prepare(
      `SELECT c.id AS card_id, st.*
         FROM kanban_cards c
         JOIN support_tickets st
           ON st.id = COALESCE(c.support_ticket_id, c.customer_report_id)
        WHERE c.board_id = ?
       UNION ALL
       SELECT c.id AS card_id, st.*
         FROM kanban_cards c
         JOIN support_tickets st
           ON st.converted_card_id = c.id
        WHERE c.board_id = ?
          AND c.support_ticket_id IS NULL
          AND c.customer_report_id IS NULL`,
    ),
    updateKanbanCard: db.prepare(
      `UPDATE kanban_cards SET title = ?, description = ?, priority = ?, assignee = ?, labels = ?, session_id = ?, github_issue_url = ?, pr_url = ?, epic_id = ?, phase_id = ?, assign_model = ?, assign_engine = ?, pr_base_branch = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    setKanbanCardAssignedUser: db.prepare(
      `UPDATE kanban_cards SET assigned_user_id = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    setKanbanCardsAssignedUserByEpic: db.prepare(
      `UPDATE kanban_cards SET assigned_user_id = ?, updated_at = datetime('now') WHERE epic_id = ?`,
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
    getKanbanCardByLogIssueSource: db.prepare(
      `SELECT c.* FROM kanban_cards c
       JOIN kanban_boards b ON b.id = c.board_id
       JOIN kanban_columns col ON col.id = c.column_id
       WHERE b.project_id = ? AND c.source_type = 'log_issue' AND c.source_id = ?
         AND lower(col.name) != 'done'
       ORDER BY c.updated_at DESC, c.id DESC LIMIT 1`,
    ),
    getKanbanCardByPrUrl: db.prepare('SELECT * FROM kanban_cards WHERE pr_url = ? LIMIT 1'),
    getNextUndocumentedCard: db.prepare(
      `SELECT c.*, col.name as column_name FROM kanban_cards c
       JOIN kanban_columns col ON c.column_id = col.id
       WHERE c.board_id = ? AND col.name = 'Done' AND c.documented = 0
       ORDER BY c.updated_at ASC LIMIT 1`,
    ),
    markCardDocumented: db.prepare(
      "UPDATE kanban_cards SET documented = 1, updated_at = datetime('now') WHERE id = ?",
    ),
    // Set/clear the per-card auto-merge preference (1 = on, 0 = off, NULL =
    // use project default). Scoped to just this column so neither the assign
    // path nor the support-ticket convert path has to round-trip the whole
    // updateKanbanCard signature.
    setKanbanCardAutoMerge: db.prepare(
      "UPDATE kanban_cards SET auto_merge = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    deleteKanbanCard: db.prepare('DELETE FROM kanban_cards WHERE id = ?'),
    // Flag a card as orphaned (its working session was closed but the card had
    // progressed too far to delete). Idempotent: re-flagging keeps the first
    // orphaned_at timestamp via COALESCE.
    markKanbanCardOrphaned: db.prepare(
      "UPDATE kanban_cards SET orphaned_at = COALESCE(orphaned_at, datetime('now')), updated_at = datetime('now') WHERE id = ?",
    ),

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
    // Count blocker edges touching a card in EITHER direction (it is blocked by
    // something, or it blocks something). Used to treat coordination state as a
    // progression signal before garbage-collecting an orphaned card.
    countBlockerEdgesForCard: db.prepare(
      'SELECT COUNT(*) AS n FROM kanban_card_blockers WHERE card_id = ? OR blocked_by_card_id = ?',
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
      // Default autonomous_max_concurrent to 1 explicitly (not just via the
      // column DEFAULT) so existing DBs created before the default dropped from
      // 2 → 1 also start new epics at 1 ticket-at-once.
      `INSERT INTO kanban_epics (id, board_id, name, description, color, position, autonomous_max_concurrent, labels) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    ),
    updateKanbanEpic: db.prepare(
      `UPDATE kanban_epics SET name = ?, description = ?, color = ?, autonomous = ?, autonomous_interval = ?, autonomous_max_concurrent = ?, autonomous_model = ?, orchestration_budgets_json = ?, pr_base_branch = ?, labels = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    updateKanbanEpicState: db.prepare(
      "UPDATE kanban_epics SET state = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    // Standalone stamp for the user who flipped autonomous mode on. Kept
    // separate from updateKanbanEpic so existing call sites (and the
    // public PUT /epics/:id payload) don't have to thread an extra arg.
    setEpicAutonomousEnabledBy: db.prepare(
      `UPDATE kanban_epics SET autonomous_enabled_by = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    // Standalone setter for the "Auto Merge" autonomous override. Kept separate
    // from updateKanbanEpic (same rationale as setEpicAutonomousEnabledBy) so
    // the many existing updateKanbanEpic call sites don't have to thread an
    // extra arg.
    setEpicAutonomousSendIt: db.prepare(
      `UPDATE kanban_epics SET autonomous_send_it = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    setKanbanEpicAssignedUser: db.prepare(
      `UPDATE kanban_epics SET assigned_user_id = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    getKanbanCardTemplates: db.prepare(
      'SELECT * FROM kanban_card_templates WHERE board_id = ? ORDER BY name ASC, created_at ASC',
    ),
    getKanbanCardTemplate: db.prepare('SELECT * FROM kanban_card_templates WHERE id = ?'),
    createKanbanCardTemplate: db.prepare(
      `INSERT INTO kanban_card_templates (id, board_id, name, title, description, priority, labels, epic_id, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateKanbanCardTemplate: db.prepare(
      `UPDATE kanban_card_templates
       SET name = ?, title = ?, description = ?, priority = ?, labels = ?, epic_id = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ),
    deleteKanbanCardTemplate: db.prepare('DELETE FROM kanban_card_templates WHERE id = ?'),
    clearKanbanCardTemplateEpic: db.prepare(
      `UPDATE kanban_card_templates
       SET epic_id = NULL, updated_at = datetime('now')
       WHERE board_id = ? AND epic_id = ?`,
    ),
    deleteKanbanEpic: db.prepare('DELETE FROM kanban_epics WHERE id = ?'),
    getKanbanCardsByEpic: db.prepare(
      'SELECT * FROM kanban_cards WHERE epic_id = ? ORDER BY position ASC',
    ),
    updateKanbanCardEpic: db.prepare(
      "UPDATE kanban_cards SET epic_id = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    updateKanbanCardPhase: db.prepare(
      "UPDATE kanban_cards SET phase_id = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    getKanbanPhases: db.prepare(
      'SELECT * FROM kanban_phases WHERE board_id = ? ORDER BY position ASC',
    ),
    getKanbanPhasesByEpic: db.prepare(
      'SELECT * FROM kanban_phases WHERE epic_id = ? ORDER BY position ASC',
    ),
    getKanbanPhase: db.prepare('SELECT * FROM kanban_phases WHERE id = ?'),
    createKanbanPhase: db.prepare(
      // Set autonomous + autonomous_send_it explicitly so phases are armed for
      // auto-dispatch and Auto Merge regardless of the column default that an
      // already-migrated DB happens to carry (older DBs created the table with a
      // DEFAULT 0). This is what makes a freshly created phase participate in the
      // sequential cascade and merge its PRs by default. autonomous_max_concurrent
      // is also set explicitly (see createKanbanEpic).
      `INSERT INTO kanban_phases (id, epic_id, board_id, name, description, position, autonomous_max_concurrent, autonomous, autonomous_send_it) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1)`,
    ),
    updateKanbanPhase: db.prepare(
      // autonomous_send_it is written here (the canonical phase-update path) so
      // the Auto Merge toggle persists like every other phase field. Callers
      // that don't change it pass the phase's current value to preserve it.
      `UPDATE kanban_phases SET name = ?, description = ?, autonomous = ?, autonomous_interval = ?, autonomous_max_concurrent = ?, autonomous_model = ?, autonomous_send_it = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    setPhaseAutonomousEnabledBy: db.prepare(
      `UPDATE kanban_phases SET autonomous_enabled_by = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    setPhaseAutonomousSendIt: db.prepare(
      `UPDATE kanban_phases SET autonomous_send_it = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    setPhaseAutonomousRunning: db.prepare(
      `UPDATE kanban_phases SET autonomous_running = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    setKanbanPhasePosition: db.prepare(
      `UPDATE kanban_phases SET position = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    deleteKanbanPhase: db.prepare('DELETE FROM kanban_phases WHERE id = ?'),
    getKanbanCardsByPhase: db.prepare(
      'SELECT * FROM kanban_cards WHERE phase_id = ? ORDER BY position ASC',
    ),
    setKanbanCardKind: db.prepare(
      "UPDATE kanban_cards SET card_kind = ?, updated_at = datetime('now') WHERE id = ?",
    ),

    getKanbanSpecItems: db.prepare(
      'SELECT * FROM kanban_epic_spec_items WHERE board_id = ? ORDER BY position ASC, title ASC',
    ),
    getKanbanSpecItemsByEpic: db.prepare(
      'SELECT * FROM kanban_epic_spec_items WHERE epic_id = ? ORDER BY position ASC, title ASC',
    ),
    getKanbanSpecItem: db.prepare('SELECT * FROM kanban_epic_spec_items WHERE id = ?'),
    getKanbanSpecItemBySpikeCard: db.prepare(
      'SELECT * FROM kanban_epic_spec_items WHERE spike_card_id = ? LIMIT 1',
    ),
    countOpenKanbanSpecItemsByEpic: db.prepare(
      "SELECT COUNT(*) AS n FROM kanban_epic_spec_items WHERE epic_id = ? AND status = 'open'",
    ),
    // Phase-scoped open-spec gate: a phase's build cards wait only on specs that
    // could affect that phase — its own (phase_id = ?) plus epic-wide, unphased
    // decisions (phase_id IS NULL). Sibling phases' open specs must NOT block it.
    countOpenKanbanSpecItemsByPhase: db.prepare(
      "SELECT COUNT(*) AS n FROM kanban_epic_spec_items WHERE epic_id = ? AND status = 'open' AND (phase_id = ? OR phase_id IS NULL)",
    ),
    createKanbanSpecItem: db.prepare(
      `INSERT INTO kanban_epic_spec_items (id, epic_id, board_id, phase_id, tag, title, decision, status, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateKanbanSpecItem: db.prepare(
      `UPDATE kanban_epic_spec_items SET tag = ?, title = ?, decision = ?, status = ?, phase_id = ?, position = ?, resolved_session_id = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    setKanbanSpecItemSpikeCard: db.prepare(
      "UPDATE kanban_epic_spec_items SET spike_card_id = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    deleteKanbanSpecItem: db.prepare('DELETE FROM kanban_epic_spec_items WHERE id = ?'),

    getAutonomousPhases: db.prepare(
      'SELECT * FROM kanban_phases WHERE board_id = ? AND autonomous_running = 1 ORDER BY name ASC',
    ),
    getEligibleAutonomousCardsByPhase: db.prepare(
      `SELECT c.* FROM kanban_cards c
       JOIN kanban_columns col ON c.column_id = col.id
       WHERE c.phase_id = ? AND col.name = 'To Do'
       AND (c.assignee IS NULL OR c.assignee = '')
       AND COALESCE(c.card_kind, 'task') != 'spike'
       AND c.id NOT IN (
         SELECT spike_card_id FROM kanban_epic_spec_items WHERE spike_card_id IS NOT NULL
       )
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
    getEligibleAutonomousSpikeCardsByPhase: db.prepare(
      `SELECT c.* FROM kanban_cards c
       JOIN kanban_columns col ON c.column_id = col.id
       WHERE c.phase_id = ? AND col.name = 'To Do'
       AND (c.assignee IS NULL OR c.assignee = '')
       AND (
         COALESCE(c.card_kind, 'task') = 'spike'
         OR c.id IN (SELECT spike_card_id FROM kanban_epic_spec_items WHERE spike_card_id IS NOT NULL)
         OR LOWER(TRIM(c.title)) LIKE 'spike:%'
       )
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
    getEligibleAutonomousSpikeCards: db.prepare(
      `SELECT c.* FROM kanban_cards c
       JOIN kanban_columns col ON c.column_id = col.id
       WHERE c.epic_id = ? AND col.name = 'To Do'
       AND (c.assignee IS NULL OR c.assignee = '')
       AND (
         COALESCE(c.card_kind, 'task') = 'spike'
         OR c.id IN (SELECT spike_card_id FROM kanban_epic_spec_items WHERE spike_card_id IS NOT NULL)
         OR LOWER(TRIM(c.title)) LIKE 'spike:%'
       )
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
    getAutonomousEpic: db.prepare(
      'SELECT * FROM kanban_epics WHERE board_id = ? AND autonomous = 1 LIMIT 1',
    ),
    // Plural variant: a board may have MORE THAN ONE epic in autonomous mode
    // at a time. The dispatch loop ticks each of these independently (each with
    // its own slot cap and single-flight gate). `getAutonomousEpic` (singular,
    // LIMIT 1) is retained for callers that only need a representative epic.
    getAutonomousEpics: db.prepare(
      'SELECT * FROM kanban_epics WHERE board_id = ? AND autonomous = 1 ORDER BY name ASC',
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
       AND COALESCE(c.card_kind, 'task') != 'spike'
       AND c.id NOT IN (
         SELECT spike_card_id FROM kanban_epic_spec_items WHERE spike_card_id IS NOT NULL
       )
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

    // Code embeddings (code-RAG). Rowid alignment with code_chunks_fts is
    // maintained in code-embeddings.ts via the rowids returned here.
    getCodeChunkRowidsByFile: db.prepare(
      'SELECT rowid FROM code_chunks WHERE project_id = ? AND file_path = ?',
    ),
    deleteCodeChunksByFile: db.prepare(
      'DELETE FROM code_chunks WHERE project_id = ? AND file_path = ?',
    ),
    deleteCodeFtsByRowid: db.prepare('DELETE FROM code_chunks_fts WHERE rowid = ?'),
    insertCodeChunk: db.prepare(
      `INSERT INTO code_chunks
         (project_id, file_path, chunk_idx, chunk_text, start_line, end_line, file_hash, embedding, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertCodeFts: db.prepare(
      'INSERT INTO code_chunks_fts (rowid, file_path, chunk_text, project_id) VALUES (?, ?, ?, ?)',
    ),
    getCodeEmbeddingsByProject: db.prepare(
      `SELECT rowid, file_path, chunk_idx, chunk_text, start_line, end_line, embedding, model
       FROM code_chunks WHERE project_id = ?`,
    ),
    getCodeFileHashes: db.prepare(
      'SELECT file_path, file_hash FROM code_chunks WHERE project_id = ? GROUP BY file_path',
    ),
    getDistinctCodeFiles: db.prepare(
      'SELECT DISTINCT file_path FROM code_chunks WHERE project_id = ?',
    ),
    countCodeChunksByProject: db.prepare(
      'SELECT COUNT(*) as n FROM code_chunks WHERE project_id = ?',
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

    // Support tickets. List queries order by severity (most severe first) then
    // newest, via a CASE rank since SQLite has no native enum ordering.
    createSupportTicket: db.prepare(
      `INSERT INTO support_tickets
         (id, project_id, type, severity, status, subject, body, reporter, reporter_email, replay_ref, screenshot_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getSupportTicket: db.prepare('SELECT * FROM support_tickets WHERE id = ?'),
    listSupportTicketsByProject: db.prepare(
      `SELECT * FROM support_tickets
       WHERE project_id = ?
       ORDER BY CASE severity
         WHEN 'critical' THEN 0
         WHEN 'high' THEN 1
         WHEN 'medium' THEN 2
         WHEN 'low' THEN 3
         ELSE 4 END ASC,
         created_at DESC,
         rowid DESC`,
    ),
    listSupportTicketsByProjectAndStatus: db.prepare(
      `SELECT * FROM support_tickets
       WHERE project_id = ? AND status = ?
       ORDER BY CASE severity
         WHEN 'critical' THEN 0
         WHEN 'high' THEN 1
         WHEN 'medium' THEN 2
         WHEN 'low' THEN 3
         ELSE 4 END ASC,
         created_at DESC,
         rowid DESC`,
    ),
    updateSupportTicketStatus: db.prepare(
      `UPDATE support_tickets SET status = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    updateSupportTicketType: db.prepare(
      `UPDATE support_tickets SET type = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    updateSupportTicketInvestigation: db.prepare(
      `UPDATE support_tickets
         SET ai_summary = ?, ai_investigation = ?, ai_investigated_at = datetime('now'),
             updated_at = datetime('now')
       WHERE id = ?`,
    ),
    setSupportTicketReplayRef: db.prepare(
      `UPDATE support_tickets SET replay_ref = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    setSupportTicketScreenshotRef: db.prepare(
      `UPDATE support_tickets SET screenshot_ref = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    setSupportTicketBody: db.prepare(
      `UPDATE support_tickets SET body = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    setSupportTicketWontDoReason: db.prepare(
      `UPDATE support_tickets SET wont_do_reason = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    convertSupportTicketToCard: db.prepare(
      `UPDATE support_tickets
         SET converted_card_id = ?, status = 'converted', updated_at = datetime('now')
       WHERE id = ?`,
    ),
    // Read/unread state. Mark-read is a no-op on an already-read ticket (the
    // `read_at IS NULL` guard) so a redundant open doesn't churn updated_at.
    markSupportTicketRead: db.prepare(
      `UPDATE support_tickets
         SET read_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND read_at IS NULL`,
    ),
    markSupportTicketUnread: db.prepare(
      `UPDATE support_tickets
         SET read_at = NULL, updated_at = datetime('now')
       WHERE id = ? AND read_at IS NOT NULL`,
    ),
    markAllSupportTicketsRead: db.prepare(
      `UPDATE support_tickets
         SET read_at = datetime('now'), updated_at = datetime('now')
       WHERE project_id = ? AND read_at IS NULL`,
    ),
    countUnreadSupportTickets: db.prepare(
      `SELECT COUNT(*) AS n FROM support_tickets WHERE project_id = ? AND read_at IS NULL`,
    ),
    deleteSupportTicket: db.prepare('DELETE FROM support_tickets WHERE id = ?'),
    deleteSupportTicketsByProject: db.prepare('DELETE FROM support_tickets WHERE project_id = ?'),

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
    // Snapshot of the in-flight runs *before* the boot sweep marks them
    // infra_error — captured so the Hub can RE-TRIGGER a fresh run per session
    // (boot-retrigger.ts) instead of leaving the work stranded. Same predicate
    // (and therefore same terminal set) as failStuckActiveFinalizeRunsOnBoot;
    // keep the two in sync. Most-recent first so per-session dedup keeps the
    // latest interrupted run.
    selectStuckActiveFinalizeRunsOnBoot: db.prepare(
      `SELECT id, session_id, card_id, project_id, head_sha
         FROM finalize_runs
        WHERE status NOT IN ('pushed','failed','timed_out','infra_error','cancelled','stalled_no_response','ready_to_push')
        ORDER BY started_at DESC, id DESC`,
    ),
    // Crash-loop guard for boot retrigger: how many times this exact
    // (session, head_sha) has already been marked infra_error by the boot
    // sweep. If the count crosses the generation cap, stop auto-retriggering
    // (a run that crashes the Hub mid-finalize would otherwise loop forever:
    // boot → retrigger → crash → boot → ...). Counts the just-swept generation
    // too, since the count runs after the sweep.
    countInterruptedFinalizeRunsForSessionHead: db.prepare(
      `SELECT COUNT(*) AS n
         FROM finalize_runs
        WHERE session_id = ?
          AND head_sha = ?
          AND status = 'infra_error'
          AND failure_reason LIKE 'Finalize run interrupted%'`,
    ),
    // A Finalize run's orchestrator + remote-fleet streaming live in the Hub
    // process; a restart/crash leaves the run row non-terminal with no live
    // handle, so it hangs forever showing "running". On boot, mark every
    // in-flight run as infra_error so it surfaces a clean failure + retrigger
    // instead. Mirrors failStuckRunningWorkflowRuns. Terminal set kept in sync
    // with FINALIZE_TERMINAL_STATUSES (server/finalize/budget.ts).
    failStuckActiveFinalizeRunsOnBoot: db.prepare(
      `UPDATE finalize_runs
       SET status = 'infra_error',
           failure_reason = 'Finalize run interrupted (server restart or crash)',
           phase = NULL,
           ended_at = COALESCE(ended_at, unixepoch() * 1000)
       WHERE status NOT IN ('pushed','failed','timed_out','infra_error','cancelled','stalled_no_response','ready_to_push')`,
    ),
    failStuckActiveFinalizeRunStepsOnBoot: db.prepare(
      `UPDATE finalize_run_steps
       SET state = 'skipped',
           ended_at = COALESCE(ended_at, unixepoch() * 1000)
       WHERE state IN ('queued','running')`,
    ),
    // ── Runtime stuck-run reaper (stuck-run-reaper.ts) ──────────────────────
    // Steady-state analog to the boot sweep above. boot-recovery only fires on
    // Hub boot; an `agent_block` run whose orchestrator dies/hangs mid-process
    // (e.g. a transient runner-lease-expiry blip, with NO restart) otherwise
    // hangs in `status='running'` forever. Scoped to `status='running'` ON
    // PURPOSE: that is the step-execution phase where the stall happens, and it
    // EXCLUDES the pre-start statuses (`queued`/`rebasing`/`reviewing`) whose
    // dispatched-but-not-started steps share the reapable shape (`queued_steps`
    // > 0, `running_steps = 0`) — reaping those would fail a pending run on the
    // happy path. `started_at` can't be the gate (it is stamped at INSERT, so it
    // is always set). Signals the reaper needs to classify WITHOUT a restart:
    //   - last_activity_ms: newest of run.started_at and any step start/end —
    //     a live orchestrator bumps this by transitioning steps, so it goes
    //     stale exactly when the run stops making progress.
    //   - queued_steps / running_steps: a real stall has stranded `queued`
    //     work with NOTHING `running` (a genuinely-executing long step keeps a
    //     `running` row, so we never reap an in-flight step).
    selectRuntimeStuckFinalizeRunCandidates: db.prepare(
      `SELECT r.id, r.status, r.session_id, r.card_id, r.project_id, r.head_sha, r.started_at,
              MAX(
                COALESCE(r.started_at, 0),
                COALESCE((SELECT MAX(s.started_at) FROM finalize_run_steps s WHERE s.run_id = r.id), 0),
                COALESCE((SELECT MAX(s.ended_at)   FROM finalize_run_steps s WHERE s.run_id = r.id), 0)
              ) AS last_activity_ms,
              (SELECT COUNT(*) FROM finalize_run_steps s WHERE s.run_id = r.id AND s.state = 'queued')  AS queued_steps,
              (SELECT COUNT(*) FROM finalize_run_steps s WHERE s.run_id = r.id AND s.state = 'running') AS running_steps
         FROM finalize_runs r
        WHERE r.status = 'running'`,
    ),
    // Flip ONE stalled run to infra_error — but ONLY if it STILL has the
    // reapable shape, REVALIDATED ATOMICALLY here so the select→reap gap can't
    // fail a run that made progress in the meantime (TOCTOU). The candidate
    // SELECT is a snapshot; between it and this write a live orchestrator could
    // (a) advance the run off `running` (e.g. to `pushing`), (b) start a queued
    // step (now `running`), or (c) finish a step (bumping last activity). Each
    // is real progress that must veto the reap. The WHERE re-checks all of it
    // against current rows: still `running`, NOTHING currently `running` in
    // steps, still has stranded `queued` work, AND still idle past @cutoff (the
    // reaper passes nowMs − the idle threshold it classified the run under, so
    // this mirrors the same idle predicate). Any miss → 0 changes → caller
    // skips. failure_reason keeps the 'Finalize run interrupted%' prefix so the
    // boot-retrigger crash-loop counter
    // (countInterruptedFinalizeRunsForSessionHead) bounds runtime reaps too:
    // reap → auto-retrigger → stall → reap can't loop forever.
    failRuntimeStuckFinalizeRun: db.prepare(
      `UPDATE finalize_runs
          SET status = 'infra_error',
              failure_reason = 'Finalize run interrupted (stalled with no live orchestrator)',
              phase = NULL,
              ended_at = COALESCE(ended_at, unixepoch() * 1000)
        WHERE id = @id
          AND status = 'running'
          AND NOT EXISTS (
                SELECT 1 FROM finalize_run_steps s
                 WHERE s.run_id = finalize_runs.id AND s.state = 'running'
              )
          AND EXISTS (
                SELECT 1 FROM finalize_run_steps s
                 WHERE s.run_id = finalize_runs.id AND s.state = 'queued'
              )
          AND MAX(
                COALESCE(finalize_runs.started_at, 0),
                COALESCE((SELECT MAX(s.started_at) FROM finalize_run_steps s WHERE s.run_id = finalize_runs.id), 0),
                COALESCE((SELECT MAX(s.ended_at)   FROM finalize_run_steps s WHERE s.run_id = finalize_runs.id), 0)
              ) <= @cutoff`,
    ),
    // Sweep the reaped run's stranded steps so its timeline reads cleanly. Only
    // `queued` steps are swept: the reap-guard above already proved no step was
    // `running` at flip time, so there is nothing in-flight to skip — and
    // scoping to `queued` means that even if a step somehow started in the
    // (synchronous, same-process) gap before this write, we never force a
    // legitimately-running step to `skipped`.
    failRuntimeStuckFinalizeRunSteps: db.prepare(
      `UPDATE finalize_run_steps
          SET state = 'skipped',
              ended_at = COALESCE(ended_at, unixepoch() * 1000)
        WHERE run_id = ?
          AND state = 'queued'`,
    ),
    // After the boot retrigger successfully starts a FRESH run for an interrupted
    // session, annotate the just-swept (old) run so its terminal bubble no longer
    // reads as an unresolved infra failure — it now self-describes that a fresh
    // run was kicked automatically. The exact-match guard on the original sweep
    // sentence keeps this idempotent (a second boot won't re-append) AND keeps the
    // 'Finalize run interrupted%' prefix intact so the crash-loop generation
    // counter (countInterruptedFinalizeRunsForSessionHead) still counts this row.
    markFinalizeRunSupersededByBootRetrigger: db.prepare(
      `UPDATE finalize_runs
          SET failure_reason =
                'Finalize run interrupted (server restart or crash) — superseded by an automatic re-run'
        WHERE id = ?
          AND status = 'infra_error'
          AND failure_reason = 'Finalize run interrupted (server restart or crash)'`,
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
        started_at, mode, job_filter
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    // Park a run at ready_to_push. The `status != 'cancelled'` guard is load
    // bearing: the cancel endpoint (POST .../finalize/:runId/cancel) can flip a
    // row to `cancelled` while the CI/runner phase is still in flight. Without
    // the guard this unconditional `WHERE id = ?` write would resurrect that
    // cancelled row back to ready_to_push, and auto-push would then ship a run
    // the user explicitly stopped. The orchestrator checks `changes === 0` and
    // bails to the cancelled terminal when the guard refuses the write.
    markFinalizeRunReadyToPush: db.prepare(
      `UPDATE finalize_runs
          SET status = 'ready_to_push',
              phase = NULL,
              validated_head_sha = ?,
              ended_at = unixepoch() * 1000
        WHERE id = ? AND status != 'cancelled'`,
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
    updateFinalizeRunLoopRound: db.prepare(`UPDATE finalize_runs SET loop_round = ? WHERE id = ?`),
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
    getPushedFinalizeRunForSession: db.prepare(
      `SELECT *
         FROM finalize_runs
        WHERE session_id = ?
          AND status = 'pushed'
        ORDER BY COALESCE(ended_at, started_at) DESC, id DESC
        LIMIT 1`,
    ),
    // Per-phase pickers. The split "Run Tests" / "Reviewer" buttons each
    // surface their own done-state, which may come from a phase-scoped run
    // (mode 'checks' / 'review') OR from a combined 'full' run that
    // exercised both. Same (started_at DESC, id DESC) tiebreak as the
    // overall picker so all three agree on which row is "latest".
    // `job_filter IS NULL` excludes single-job "Run Tests" dropdown debug
    // runs: a partial run must never become the phase summary that flips the
    // "Tested" badge, nor count toward full validation / push automation. The
    // full suite (mode 'checks'/'full' with no filter) is the only thing that
    // can mark a session tested.
    getLatestChecksRunForSession: db.prepare(
      `SELECT *
         FROM finalize_runs
        WHERE session_id = ?
          AND mode IN ('checks', 'full')
          AND job_filter IS NULL
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
    ),
    getLatestReviewRunForSession: db.prepare(
      `SELECT *
         FROM finalize_runs
        WHERE session_id = ?
          AND mode IN ('review', 'full')
          AND job_filter IS NULL
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
          AND status NOT IN ('pushed', 'failed', 'timed_out', 'infra_error', 'cancelled', 'stalled_no_response', 'ready_to_push')
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
    ),
    // All non-terminal finalize runs that have a session_id, newest first.
    // Backs the WS connect-snapshot (server/finalize/finalize-snapshot.ts):
    // every (re)connection replays one finalize_run_phase_changed per active
    // run so the client converges regardless of which live events it missed.
    // Excludes the six terminal statuses but keeps the parked `ready_to_push`
    // so the sidebar/button reflect that state after a reconnect too.
    getActiveFinalizeRuns: db.prepare(
      `SELECT id, session_id, phase, status
         FROM finalize_runs
        WHERE session_id IS NOT NULL
          AND status NOT IN ('pushed', 'failed', 'timed_out', 'infra_error', 'cancelled', 'stalled_no_response')
        ORDER BY started_at DESC, id DESC`,
    ),
    getActiveFinalizeRunForSessionBranch: db.prepare(
      `SELECT *
         FROM finalize_runs
        WHERE session_id = ?
          AND branch = ?
          AND (
            (job_filter IS NULL AND ? IS NULL)
            OR job_filter = ?
          )
          AND status NOT IN ('pushed', 'failed', 'timed_out', 'infra_error', 'cancelled', 'stalled_no_response', 'ready_to_push')
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
    ),
    insertFinalizeKickoffClaim: db.prepare(
      `INSERT OR IGNORE INTO finalize_kickoff_claims
        (claim_key, session_id, branch, mode, job_filter, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    deleteFinalizeKickoffClaim: db.prepare(
      `DELETE FROM finalize_kickoff_claims WHERE claim_key = ?`,
    ),
    pruneStaleFinalizeKickoffClaims: db.prepare(
      `DELETE FROM finalize_kickoff_claims WHERE created_at < ?`,
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
    claimFinalizeRunPush: db.prepare(
      `UPDATE finalize_runs
          SET phase = 'push',
              status = 'pushing'
        WHERE id = ?
          AND status = 'ready_to_push'
          AND NOT EXISTS (
            SELECT 1
              FROM finalize_runs peer
             WHERE peer.id != finalize_runs.id
               AND peer.session_id = finalize_runs.session_id
               AND (
                 peer.status = 'pushing'
                 OR (
                   peer.validated_head_sha = ?
                   AND peer.status = 'pushed'
                 )
               )
          )`,
    ),
    getFinalizePushPeerForSessionHead: db.prepare(
      `SELECT *
         FROM finalize_runs
        WHERE id != ?
          AND session_id = ?
          AND (
            status = 'pushing'
            OR (
              validated_head_sha = ?
              AND status = 'pushed'
            )
          )
        ORDER BY CASE status WHEN 'pushing' THEN 0 ELSE 1 END,
                 ended_at DESC,
                 started_at DESC,
                 id DESC
        LIMIT 1`,
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
    // NOTE: the log-location columns (log_storage_*, log_key, log_lines,
    // log_truncated, log_attempt) are deliberately NOT written here. Their
    // lifecycle is owned exclusively by `beginFinalizeRunStepAttempt` (clears
    // them + stamps a fresh attempt nonce when an execution STARTS) and
    // `attachFinalizeRunStepLog` (sets them when the upload finishes). Leaving
    // them out of this upsert means a normal state transition (queued →
    // running → passed/failed) never resurrects a previous execution's stale
    // location — and there is no COALESCE that could preserve it across a
    // re-run.
    //
    // started_at semantics (per-EXECUTION, not per-row): a fix round re-runs
    // checks by re-queuing the SAME (run_id, step_index) rows, so the stamp
    // must follow the latest execution —
    //   - re-queue (state='queued')  → reset to NULL (fresh round, fresh clock);
    //   - start   (state='running')  → overwrite with this execution's start;
    //   - terminal                   → apply ONLY if it carries the row's
    //     current started_at (the terminal WHERE guard below).
    // The old `COALESCE(existing, excluded)` kept the ROUND-1 stamp forever,
    // so after N fix rounds the UI showed steps "running" for the cumulative
    // wall-clock of every round (support: "These have been running for hours").
    //
    // Out-of-order-write guard: a DELAYED terminal write from a previous
    // execution (e.g. a zombie remote runner settling after the row was
    // re-queued/restarted) must not clobber the current round. The REAL
    // terminal writer (announceStepEnd) does not use this upsert — it goes
    // through finishFinalizeRunStepIfAttempt below, guarded on the
    // per-execution `log_attempt` nonce (a wall-clock stamp is not
    // collision-safe: a restart can land in the same millisecond). The
    // WHERE here is defense-in-depth for any other conflicting terminal
    // write: it only applies when the write echoes the row's current
    // started_at (`IS` = null-safe compare). queued/running writes are
    // orchestrator-ordered round boundaries and always apply.
    upsertFinalizeRunStep: db.prepare(
      `INSERT INTO finalize_run_steps (
        run_id, step_index, name, state, exit_code, started_at, ended_at, job_id, matrix_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, step_index) DO UPDATE SET
        name = excluded.name,
        state = excluded.state,
        exit_code = excluded.exit_code,
        started_at = CASE
          WHEN excluded.state = 'queued' THEN NULL
          ELSE COALESCE(excluded.started_at, finalize_run_steps.started_at)
        END,
        ended_at = excluded.ended_at,
        job_id = excluded.job_id,
        matrix_key = excluded.matrix_key
      WHERE excluded.state IN ('queued', 'running')
         OR finalize_run_steps.started_at IS excluded.started_at`,
    ),
    // Terminal step write, guarded on the per-execution `log_attempt` nonce
    // minted by beginFinalizeRunStepAttempt when the execution started. This
    // is the ONLY statement announceStepEnd uses: a delayed terminal from a
    // superseded execution carries that execution's nonce and matches zero
    // rows — even when a retry/fix-round restart happened within the same
    // millisecond (which defeats any timestamp-based identity). The
    // `state = 'running'` conjunct additionally rejects a stale terminal
    // arriving after the row was re-queued but before it restarted (the
    // nonce is only re-minted on start, so it alone would still match).
    // started_at is deliberately untouched — the running write's stamp is
    // preserved for duration display. Callers must check `changes`: 0 means
    // the write was stale and MUST NOT be broadcast.
    finishFinalizeRunStepIfAttempt: db.prepare(
      `UPDATE finalize_run_steps
          SET state = ?, exit_code = ?, ended_at = ?
        WHERE run_id = ? AND step_index = ?
          AND state = 'running'
          AND log_attempt IS ?`,
    ),
    listFinalizeRunStepsForRun: db.prepare(
      `SELECT run_id, step_index, name, state, exit_code, started_at, ended_at, job_id, matrix_key,
              log_storage_kind, log_storage_bucket, log_storage_region, log_key, log_lines, log_truncated,
              log_attempt
         FROM finalize_run_steps
        WHERE run_id = ?
        ORDER BY step_index ASC`,
    ),
    // Terminal-reconcile: sweep one run's still-in-flight step rows to a
    // terminal `skipped` state. A v2 matrix run marks the run terminal on the
    // FIRST shard to fail (see runStepsSequence); sibling shards that were still
    // queued/running when the run ended (or when the orchestrator crashed) leave
    // their step rows stuck non-terminal, so the Runners/checks panel shows them
    // "running" forever. `reconcileFinalizeRunTerminalSteps` calls this per
    // stuck step (then broadcasts the terminal state) so the panel converges to
    // the run's terminal truth. Scoped to (run_id, step_index) + a non-terminal
    // guard so it can never clobber a step that legitimately passed/failed.
    markFinalizeRunStepSkippedIfPending: db.prepare(
      `UPDATE finalize_run_steps
          SET state = 'skipped',
              ended_at = COALESCE(ended_at, unixepoch() * 1000)
        WHERE run_id = ? AND step_index = ? AND state IN ('queued', 'running')`,
    ),
    // Terminal-reconcile: backfill the run-row failed-step summary from the
    // first `failed` step row. `failFinalizeRun` records status + failure_reason
    // + ended_at but NOT which step failed, so `failed_step_index/name/exit_code`
    // stay NULL and surfaces that name the failing step from the run row render
    // "failed" with nothing to point at. The `failed_step_index IS NULL` guard
    // makes this idempotent and prevents overwriting an already-recorded summary.
    backfillFinalizeRunFailedStep: db.prepare(
      `UPDATE finalize_runs
          SET failed_step_index = ?,
              failed_step_name = ?,
              failed_step_exit_code = ?
        WHERE id = ? AND failed_step_index IS NULL`,
    ),
    // Boot-recovery variant: backfill failed_step_* for EVERY terminal-failed
    // run whose summary is still NULL but which has a `failed` step row. Covers
    // runs left inconsistent by a crash (or the premature shard-terminal write)
    // that never reached the in-process reconcile path. Correlated subqueries
    // pick the first failed step per run; the EXISTS guard skips runs with no
    // failed step (e.g. infra_error with all steps skipped).
    backfillFinalizeRunFailedStepsOnBoot: db.prepare(
      `UPDATE finalize_runs
          SET failed_step_index = (
                SELECT s.step_index FROM finalize_run_steps s
                 WHERE s.run_id = finalize_runs.id AND s.state = 'failed'
                 ORDER BY s.step_index ASC LIMIT 1
              ),
              failed_step_name = (
                SELECT s.name FROM finalize_run_steps s
                 WHERE s.run_id = finalize_runs.id AND s.state = 'failed'
                 ORDER BY s.step_index ASC LIMIT 1
              ),
              failed_step_exit_code = (
                SELECT s.exit_code FROM finalize_run_steps s
                 WHERE s.run_id = finalize_runs.id AND s.state = 'failed'
                 ORDER BY s.step_index ASC LIMIT 1
              )
        WHERE status IN ('failed', 'timed_out')
          AND failed_step_index IS NULL
          AND EXISTS (
                SELECT 1 FROM finalize_run_steps s
                 WHERE s.run_id = finalize_runs.id AND s.state = 'failed'
              )`,
    ),
    getFinalizeRunStep: db.prepare(
      `SELECT run_id, step_index, name, state, exit_code, started_at, ended_at, job_id, matrix_key,
              log_storage_kind, log_storage_bucket, log_storage_region, log_key, log_lines, log_truncated,
              log_attempt
         FROM finalize_run_steps
        WHERE run_id = ? AND step_index = ?`,
    ),
    // Begin a new execution of a step: stamp a fresh per-execution nonce and
    // CLEAR any prior log location. This is what guarantees a re-run/retry of
    // the same (run_id, step_index) never shows the previous attempt's blob —
    // including the case where the new best-effort upload later fails or times
    // out (the row simply has no location, rather than a stale one).
    beginFinalizeRunStepAttempt: db.prepare(
      `UPDATE finalize_run_steps
          SET log_attempt = ?,
              log_storage_kind = NULL, log_storage_bucket = NULL, log_storage_region = NULL,
              log_key = NULL, log_lines = NULL, log_truncated = NULL
        WHERE run_id = ? AND step_index = ?`,
    ),
    // Attach a step's log-store location AFTER its terminal state is persisted,
    // so a slow/hung upload never holds the step row in `running`. Only the log
    // columns are touched — state/timing are left intact. Guarded on the
    // per-execution `log_attempt` nonce: a stale upload from an earlier attempt
    // carries that attempt's nonce, so once the step is re-executed (new nonce
    // via beginFinalizeRunStepAttempt) the stale attach matches zero rows and
    // cannot clobber the newer execution's location.
    attachFinalizeRunStepLog: db.prepare(
      `UPDATE finalize_run_steps
          SET log_storage_kind = ?, log_storage_bucket = ?, log_storage_region = ?,
              log_key = ?, log_lines = ?, log_truncated = ?
        WHERE run_id = ? AND step_index = ? AND log_attempt = ?`,
    ),
    // started_at follows the same per-EXECUTION semantics as
    // upsertFinalizeRunStep above (re-queue resets, start overwrites, terminal
    // preserves — the stamp exists purely for duration display). Identity is
    // the `attempt` nonce, NOT the timestamp: the 'running' write mints a
    // fresh nonce for the execution, its terminal write echoes it, and the
    // WHERE only applies a terminal write when the nonce matches the row's
    // current execution (`IS` = null-safe). A delayed terminal from an
    // abandoned earlier execution carries that execution's nonce and matches
    // zero rows — even when a retry/restart landed in the same millisecond
    // (which defeats any timestamp identity).
    //
    // Terminal writes additionally require the row to still be LIVE
    // (`state IN ('queued','running')`) — the jobs analog of the step
    // guard's `state = 'running'` conjunct — so a duplicate/replayed
    // terminal from the SAME execution (matching nonce) can never rewrite an
    // already-terminal row (e.g. flip `passed` to `failed`). The live set
    // includes 'queued' (unlike steps) because fail-fast `skipped` writes
    // legitimately terminalize a job that never started: they pass a NULL
    // nonce against a re-queued NULL row, which the null-safe IS accepts —
    // while a `passed`/`failed` write always carries its execution's non-null
    // nonce, so it can never apply to a queued (NULL-nonce) row.
    // queued/running writes are orchestrator-ordered round boundaries and
    // always apply (queued also resets the nonce).
    upsertFinalizeRunJob: db.prepare(
      `INSERT INTO finalize_run_jobs (
        run_id, job_id, matrix_key, state, exit_code, started_at, ended_at, attempt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, job_id, matrix_key) DO UPDATE SET
        state = excluded.state,
        exit_code = excluded.exit_code,
        started_at = CASE
          WHEN excluded.state = 'queued' THEN NULL
          ELSE COALESCE(excluded.started_at, finalize_run_jobs.started_at)
        END,
        ended_at = excluded.ended_at,
        attempt = CASE
          WHEN excluded.state = 'queued' THEN NULL
          WHEN excluded.state = 'running' THEN excluded.attempt
          ELSE finalize_run_jobs.attempt
        END
      WHERE excluded.state IN ('queued', 'running')
         OR (finalize_run_jobs.attempt IS excluded.attempt
             AND finalize_run_jobs.state IN ('queued', 'running'))`,
    ),
    listFinalizeRunJobsForRun: db.prepare(
      `SELECT run_id, job_id, matrix_key, state, exit_code, started_at, ended_at
         FROM finalize_run_jobs
        WHERE run_id = ?
        ORDER BY job_id ASC, matrix_key ASC`,
    ),
    // Run-history list for the Runners page (all triggers: finalize,
    // autonomous, push-CI). Newest first, capped by the route.
    listFinalizeRunsForProject: db.prepare(
      `SELECT * FROM finalize_runs
        WHERE project_id = ?
          AND (? = 'all' OR trigger_source = ?)
        ORDER BY started_at DESC
        LIMIT ?`,
    ),
    upsertFinalizeRunJobAttempt: db.prepare(
      `INSERT INTO finalize_run_job_attempts (
        run_id, job_id, matrix_key, round, state, exit_code, head_sha, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, job_id, matrix_key, round) DO UPDATE SET
        state = excluded.state,
        exit_code = excluded.exit_code,
        head_sha = excluded.head_sha,
        recorded_at = excluded.recorded_at`,
    ),
    listFinalizeRunJobAttemptsForRun: db.prepare(
      `SELECT run_id, job_id, matrix_key, round, state, exit_code, head_sha, recorded_at
         FROM finalize_run_job_attempts
        WHERE run_id = ?
        ORDER BY round ASC, job_id ASC, matrix_key ASC`,
    ),
    setFinalizeRunFlakeRecoveredJobs: db.prepare(
      `UPDATE finalize_runs SET flake_recovered_jobs = ? WHERE id = ?`,
    ),

    // finalize_test_history — cross-run per-instance flake history.
    upsertFinalizeTestHistory: db.prepare(
      `INSERT INTO finalize_test_history (
        run_id, project_id, job_id, matrix_key, branch, head_sha, final_state, flaked, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, job_id, matrix_key) DO UPDATE SET
        final_state = excluded.final_state,
        flaked = excluded.flaked,
        head_sha = excluded.head_sha,
        branch = excluded.branch,
        recorded_at = excluded.recorded_at`,
    ),
    listFinalizeTestHistoryForProject: db.prepare(
      `SELECT run_id, project_id, job_id, matrix_key, branch, head_sha, final_state, flaked, recorded_at
         FROM finalize_test_history
        WHERE project_id = ? AND recorded_at >= ?
        ORDER BY recorded_at DESC`,
    ),

    // finalize_quarantine — flaky-test quarantine lane.
    upsertFinalizeQuarantine: db.prepare(
      `INSERT INTO finalize_quarantine (
        id, project_id, job_id, matrix_key, owner, reason, quarantined_at, expires_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, job_id, matrix_key) DO UPDATE SET
        owner = excluded.owner,
        reason = excluded.reason,
        quarantined_at = excluded.quarantined_at,
        expires_at = excluded.expires_at,
        created_by = excluded.created_by`,
    ),
    listFinalizeQuarantineForProject: db.prepare(
      `SELECT id, project_id, job_id, matrix_key, owner, reason, quarantined_at, expires_at, created_by
         FROM finalize_quarantine
        WHERE project_id = ?
        ORDER BY expires_at ASC`,
    ),
    getFinalizeQuarantineById: db.prepare(
      `SELECT id, project_id, job_id, matrix_key, owner, reason, quarantined_at, expires_at, created_by
         FROM finalize_quarantine
        WHERE id = ?`,
    ),
    deleteFinalizeQuarantine: db.prepare(
      `DELETE FROM finalize_quarantine WHERE id = ? AND project_id = ?`,
    ),

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

    // finalize_metrics — append-only adoption-metrics event log. See
    // `server/finalize/metrics-schema.ts` and `server/finalize/metrics.ts`.
    insertFinalizeMetric: db.prepare(
      `INSERT INTO finalize_metrics (project_id, metric_name, labels, value, run_id, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    // All metrics in a (project, range) window. The read endpoint groups
    // in TypeScript (`aggregateMetrics`) instead of running one query
    // per metric so the prepared-statement cache stays small and the
    // window scan stays a single index seek.
    listAllFinalizeMetricsInRange: db.prepare(
      `SELECT id, project_id, metric_name, labels, value, run_id, observed_at
         FROM finalize_metrics
        WHERE project_id = ?
          AND observed_at >= ?
          AND observed_at < ?
        ORDER BY metric_name ASC, observed_at ASC`,
    ),
    // Per-job resource rows for ONE run (peak memory + peak CPU). Powers the
    // per-run UI badges; the aggregate panel reads via listAllFinalizeMetricsInRange.
    listFinalizeJobResourcesByRun: db.prepare(
      `SELECT metric_name, labels, value, observed_at
         FROM finalize_metrics
        WHERE project_id = ?
          AND run_id = ?
          AND metric_name IN ('finalize_job_peak_memory_bytes', 'finalize_job_cpu_percent')
        ORDER BY observed_at ASC`,
    ),

    // finalize_github_parity — Finalize↔GitHub parity harness. See
    // `server/finalize/parity-store.ts`. Upsert keyed on (project, commit).
    upsertFinalizeParity: db.prepare(
      `INSERT INTO finalize_github_parity
         (id, project_id, pr_number, commit_sha, run_id, finalize_verdict,
          finalize_jobs, github_verdict, github_jobs, divergence_class, note, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, commit_sha) DO UPDATE SET
         pr_number = excluded.pr_number,
         run_id = excluded.run_id,
         finalize_verdict = excluded.finalize_verdict,
         finalize_jobs = excluded.finalize_jobs,
         github_verdict = excluded.github_verdict,
         github_jobs = excluded.github_jobs,
         divergence_class = excluded.divergence_class,
         note = excluded.note,
         observed_at = excluded.observed_at`,
    ),
    getFinalizeParityByCommit: db.prepare(
      `SELECT id, project_id, pr_number, commit_sha, run_id, finalize_verdict,
              finalize_jobs, github_verdict, github_jobs, divergence_class, note, observed_at
         FROM finalize_github_parity
        WHERE project_id = ? AND commit_sha = ?`,
    ),
    listFinalizeParityInRange: db.prepare(
      `SELECT id, project_id, pr_number, commit_sha, run_id, finalize_verdict,
              finalize_jobs, github_verdict, github_jobs, divergence_class, note, observed_at
         FROM finalize_github_parity
        WHERE project_id = ?
          AND observed_at >= ?
          AND observed_at < ?
        ORDER BY observed_at DESC`,
    ),

    // finalize_server_ci — server-stored ci.yaml fallback. One row per
    // (project, scope). `owner_user_id` NULL = project scope, non-null =
    // personal. Reads/upsert/delete key on (project_id, IFNULL(owner_user_id,'')).
    // See `server/finalize/ci-config-store.ts`.
    getFinalizeServerCi: db.prepare(
      `SELECT id, project_id, owner_user_id, yaml_text, updated_by, updated_at
         FROM finalize_server_ci
        WHERE project_id = ? AND IFNULL(owner_user_id, '') = IFNULL(?, '')`,
    ),
    listFinalizeServerCiForProject: db.prepare(
      `SELECT id, project_id, owner_user_id, yaml_text, updated_by, updated_at
         FROM finalize_server_ci
        WHERE project_id = ?
        ORDER BY (owner_user_id IS NULL) DESC, updated_at DESC`,
    ),
    upsertFinalizeServerCi: db.prepare(
      `INSERT INTO finalize_server_ci
         (id, project_id, owner_user_id, yaml_text, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, IFNULL(owner_user_id, '')) DO UPDATE SET
         yaml_text = excluded.yaml_text,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    ),
    deleteFinalizeServerCi: db.prepare(
      `DELETE FROM finalize_server_ci
        WHERE project_id = ? AND IFNULL(owner_user_id, '') = IFNULL(?, '')`,
    ),

    // pull_requests — native PRs for Agent Hub-hosted projects. Number
    // allocation (`maxPullRequestNumberForProject` + insert) MUST run
    // inside a transaction — see server/native-pr/store.ts.
    insertPullRequest: db.prepare(
      `INSERT INTO pull_requests (
        id, project_id, number, title, body, head_branch, base_branch,
        head_sha, status, author, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    ),
    maxPullRequestNumberForProject: db.prepare(
      'SELECT COALESCE(MAX(number), 0) AS max_number FROM pull_requests WHERE project_id = ?',
    ),
    getPullRequestByNumber: db.prepare(
      'SELECT * FROM pull_requests WHERE project_id = ? AND number = ?',
    ),
    listPullRequestsForProject: db.prepare(
      `SELECT * FROM pull_requests
        WHERE project_id = ?
          AND (? = 'all' OR (? = 'open' AND status = 'open') OR (? = 'closed' AND status != 'open'))
        ORDER BY updated_at DESC
        LIMIT ?`,
    ),
    // Every PR (any state) touching a branch as base or head. Unbounded on
    // purpose: the epic-pulls endpoint filters by an epic's feature branch, so
    // an in-memory page limit could silently drop related PRs.
    listPullRequestsForBranch: db.prepare(
      `SELECT * FROM pull_requests
        WHERE project_id = ? AND (base_branch = ? OR head_branch = ?)
        ORDER BY updated_at DESC`,
    ),
    getOpenPullRequestByHeadBranch: db.prepare(
      `SELECT * FROM pull_requests
        WHERE project_id = ? AND head_branch = ? AND status = 'open'
        ORDER BY number DESC LIMIT 1`,
    ),
    updatePullRequestHead: db.prepare(
      'UPDATE pull_requests SET head_sha = ?, title = ?, body = ?, updated_at = ? WHERE id = ?',
    ),
    // Title/body edit from the PR detail UI — open PRs only.
    updatePullRequestText: db.prepare(
      `UPDATE pull_requests SET title = ?, body = ?, updated_at = ? WHERE id = ? AND status = 'open'`,
    ),
    markPullRequestMerged: db.prepare(
      `UPDATE pull_requests
          SET status = 'merged', merged_sha = ?, merged_by = ?, merge_method = ?,
              merged_at = ?, updated_at = ?
        WHERE id = ? AND status = 'open'`,
    ),
    markPullRequestClosed: db.prepare(
      `UPDATE pull_requests
          SET status = 'closed', closed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'open'`,
    ),
    // Guarded closed → open transition (merged PRs stay closed forever).
    markPullRequestReopened: db.prepare(
      `UPDATE pull_requests
          SET status = 'open', closed_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'closed'`,
    ),
    // Review-request flag. Params: (requested_at|null, requested_by|null, updated_at, id).
    setPullRequestReviewRequested: db.prepare(
      'UPDATE pull_requests SET review_requested_at = ?, review_requested_by = ?, updated_at = ? WHERE id = ?',
    ),
    insertPullRequestReview: db.prepare(
      `INSERT INTO pull_request_reviews (id, project_id, pr_number, reviewer, state, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    listPullRequestReviewsForPr: db.prepare(
      `SELECT * FROM pull_request_reviews
        WHERE project_id = ? AND pr_number = ?
        ORDER BY created_at ASC`,
    ),
    insertPullRequestComment: db.prepare(
      `INSERT INTO pull_request_comments (id, project_id, pr_number, author, file_path, line, side, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    listPullRequestCommentsForPr: db.prepare(
      `SELECT * FROM pull_request_comments
        WHERE project_id = ? AND pr_number = ?
        ORDER BY created_at ASC`,
    ),
    getPullRequestComment: db.prepare('SELECT * FROM pull_request_comments WHERE id = ?'),
    deletePullRequestComment: db.prepare('DELETE FROM pull_request_comments WHERE id = ?'),
    // "Was this exact sha fully validated by Finalize?" — review + checks
    // both passed (mode 'full' reaching ready_to_push/pushing/pushed). Drives
    // the PR-level validation passthrough: validated heads skip PR CI and the
    // external-push auto-reviewer. This intentionally keys on the commit sha,
    // not the branch: Finalize validates the commit object, and a session can
    // create/switch to a different PR head branch after the session worktree
    // was provisioned.
    //
    // 'pushing' MUST be in the accepted set. `validated_head_sha` is stamped
    // at ready_to_push (markFinalizeRunReadyToPush), before the run claims the
    // push (claimFinalizeRunPush flips status ready_to_push → pushing) and
    // before markFinalizeRunPushed flips it to 'pushed'. The actual `git push`
    // + native-PR creation happen entirely inside that 'pushing' window, and
    // both the smart-HTTP onPush hook and the onPrHeadChanged('created') hook
    // fire the passthrough checks synchronously there. Excluding 'pushing'
    // meant a Finalize-validated head was mis-classified as an external push
    // mid-push: a redundant Reviewer was dispatched (often "changes requested")
    // and PR CI re-ran on an already-validated sha. The sha match keeps this
    // exact — a push that ultimately fails never moved the ref to this sha.
    getValidatedFinalizeRunForSha: db.prepare(
      `SELECT * FROM finalize_runs
        WHERE project_id = ? AND validated_head_sha = ?
          AND mode = 'full' AND status IN ('ready_to_push', 'pushing', 'pushed')
        ORDER BY started_at DESC LIMIT 1`,
    ),
    // Latest CI-bearing run for a commit regardless of trigger (finalize,
    // branch push CI, PR CI) — feeds the PR detail's checks rows.
    getLatestFinalizeRunForSha: db.prepare(
      `SELECT * FROM finalize_runs
        WHERE project_id = ? AND (head_sha = ? OR validated_head_sha = ?)
        ORDER BY started_at DESC LIMIT 1`,
    ),
    // ALL runs for a commit, newest first — per-job re-runs create runs
    // holding a single job, so PR checks merge the newest result per job
    // across runs (GitHub's per-check-name semantics).
    listFinalizeRunsForSha: db.prepare(
      `SELECT * FROM finalize_runs
        WHERE project_id = ? AND (head_sha = ? OR validated_head_sha = ?)
        ORDER BY started_at DESC LIMIT 20`,
    ),
  } as Stmts;

  // Phase 1 async-DB instrumentation. When disabled (the default),
  // `instrumentStmts` returns the map untouched — zero per-call overhead.
  configureDbInstrumentation(config.dbInstrumentation);
  stmts = instrumentStmts(stmts);

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
