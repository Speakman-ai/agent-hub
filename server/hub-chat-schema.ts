import type Database from 'better-sqlite3';

/**
 * Agent Hub first-party chat tables. Applied from `initDb` in `db.ts`; every
 * statement is `IF NOT EXISTS`, so re-running it is a no-op. Store:
 * `hub-chat-store.ts`.
 *
 * Channels are flat (no reply threads). `seq` is a per-channel counter assigned
 * inside the append transaction, and unread state is the Mattermost/Stream
 * last-read pattern: a member's unread count is the number of other people's
 * messages with `seq > last_read_seq`.
 *
 * User ids reference `orgs.db`, so they carry no foreign key here.
 */
export const HUB_CHAT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS hub_chat_channels (
    id                 TEXT PRIMARY KEY,
    org_id             TEXT NOT NULL,
    kind               TEXT NOT NULL
                         CHECK(kind IN ('dm','group','channel','trigger','agent','summary')),
    name               TEXT NOT NULL DEFAULT '',
    topic              TEXT,
    -- Private channels, groups and DMs are member-only; public channels are
    -- joinable by any org member.
    is_private         INTEGER NOT NULL DEFAULT 0,
    project_id         TEXT,
    agent_id           TEXT,
    -- kind='agent': the chat session posts dispatch into or continue.
    session_id         TEXT,
    -- Sorted "userA:userB" for kind='dm', so the same pair always resolves to
    -- one channel. NULL for every other kind.
    dm_key             TEXT,
    created_by_user_id TEXT,
    archived_at        TEXT,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_chat_channels_dm_key
    ON hub_chat_channels(org_id, dm_key) WHERE dm_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_hub_chat_channels_org_kind
    ON hub_chat_channels(org_id, kind);

  CREATE TABLE IF NOT EXISTS hub_chat_members (
    channel_id     TEXT NOT NULL REFERENCES hub_chat_channels(id) ON DELETE CASCADE,
    user_id        TEXT NOT NULL,
    role           TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','member')),
    last_read_seq  INTEGER NOT NULL DEFAULT 0,
    notify_level   TEXT NOT NULL DEFAULT 'mentions'
                     CHECK(notify_level IN ('all','mentions','none')),
    muted_until    TEXT,
    joined_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (channel_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_hub_chat_members_user
    ON hub_chat_members(user_id);

  CREATE TABLE IF NOT EXISTS hub_chat_messages (
    id               TEXT PRIMARY KEY,
    channel_id       TEXT NOT NULL REFERENCES hub_chat_channels(id) ON DELETE CASCADE,
    seq              INTEGER NOT NULL,
    author_kind      TEXT NOT NULL CHECK(author_kind IN ('user','agent','system','trigger')),
    author_user_id   TEXT,
    author_agent_id  TEXT,
    body             TEXT NOT NULL DEFAULT '',
    refs_json        TEXT,
    payload_json     TEXT,
    edited_at        TEXT,
    deleted_at       TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    -- Bumped on every reaction or pin change (see HUB_CHAT_COLUMN_MIGRATIONS).
    meta_rev         INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_chat_messages_channel_seq
    ON hub_chat_messages(channel_id, seq);

  CREATE TABLE IF NOT EXISTS hub_chat_refs (
    message_id  TEXT NOT NULL REFERENCES hub_chat_messages(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK(kind IN ('user','agent','session','card','ticket','pr')),
    target_id   TEXT NOT NULL,
    project_id  TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_chat_refs_unique
    ON hub_chat_refs(message_id, kind, target_id, IFNULL(project_id, ''));
  CREATE INDEX IF NOT EXISTS idx_hub_chat_refs_target
    ON hub_chat_refs(kind, target_id);

  -- Agent channels: one row per member post handed to the channel's session,
  -- until its reply is posted. turn_id is the id the post's user message is
  -- stored (or queued) under in that session. Kept in the db so a post queued
  -- or in flight across a server restart still gets its reply.
  CREATE TABLE IF NOT EXISTS hub_chat_agent_turns (
    turn_id           TEXT PRIMARY KEY,
    channel_id        TEXT NOT NULL REFERENCES hub_chat_channels(id) ON DELETE CASCADE,
    session_id        TEXT,
    started           INTEGER NOT NULL DEFAULT 0,
    -- The turn's latest assistant message, posted once the turn is over.
    reply_message_id  TEXT,
    reply_content     TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_hub_chat_agent_turns_session
    ON hub_chat_agent_turns(session_id);

  -- Project triggers: route one project event (see shared/utils/chatTriggers.ts)
  -- into a chat channel. filter_json narrows which occurrences post.
  CREATE TABLE IF NOT EXISTS project_chat_triggers (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL,
    event              TEXT NOT NULL,
    filter_json        TEXT,
    channel_id         TEXT NOT NULL REFERENCES hub_chat_channels(id) ON DELETE CASCADE,
    enabled            INTEGER NOT NULL DEFAULT 1,
    created_by         TEXT,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_project_chat_triggers_project_event
    ON project_chat_triggers(project_id, event);

  -- One row per (trigger, occurrence) a trigger has posted, written in the
  -- same transaction as the message, so a duplicate broadcast of an occurrence
  -- can never post twice and a failed post leaves nothing behind.
  CREATE TABLE IF NOT EXISTS project_chat_trigger_posts (
    trigger_id      TEXT NOT NULL REFERENCES project_chat_triggers(id) ON DELETE CASCADE,
    occurrence_key  TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (trigger_id, occurrence_key)
  );
  CREATE INDEX IF NOT EXISTS idx_project_chat_trigger_posts_created
    ON project_chat_trigger_posts(created_at);

  -- Scheduled AI digest for a channel: at most one per channel. Runs on the
  -- owner's engine credentials and posts as author_kind='system'.
  -- window_start is the durable cursor: the next run summarizes
  -- [window_start, now). Only a posted or skipped run moves it (to that run's
  -- end); a failed run leaves it, so the retry covers the same span.
  CREATE TABLE IF NOT EXISTS hub_chat_channel_digests (
    channel_id      TEXT PRIMARY KEY REFERENCES hub_chat_channels(id) ON DELETE CASCADE,
    enabled         INTEGER NOT NULL DEFAULT 1,
    cron            TEXT NOT NULL,
    time_zone       TEXT NOT NULL DEFAULT 'UTC',
    scope           TEXT NOT NULL CHECK(scope IN ('channel','project')),
    project_id      TEXT,
    owner_user_id   TEXT NOT NULL,
    window_start    TEXT NOT NULL,
    last_run_at     TEXT,
    last_status     TEXT CHECK(last_status IS NULL OR last_status IN ('posted','skipped','error')),
    last_error      TEXT,
    last_message_id TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- Emoji reactions: one row per (message, user, emoji).
  CREATE TABLE IF NOT EXISTS hub_chat_reactions (
    message_id  TEXT NOT NULL REFERENCES hub_chat_messages(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL,
    emoji       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (message_id, user_id, emoji)
  );

  -- Pinned messages, at most one pin per message. channel_id is denormalized
  -- so a channel's pinned list is one indexed read.
  CREATE TABLE IF NOT EXISTS hub_chat_pins (
    message_id         TEXT PRIMARY KEY REFERENCES hub_chat_messages(id) ON DELETE CASCADE,
    channel_id         TEXT NOT NULL REFERENCES hub_chat_channels(id) ON DELETE CASCADE,
    pinned_by_user_id  TEXT,
    pinned_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_hub_chat_pins_channel
    ON hub_chat_pins(channel_id, pinned_at);

  -- The turn a session with channel turns is running now (a channel turn or
  -- one started in the session directly).
  CREATE TABLE IF NOT EXISTS hub_chat_agent_session_turns (
    session_id  TEXT PRIMARY KEY,
    turn_id     TEXT NOT NULL
  );
`;

/**
 * Columns added after the tables first shipped. `CREATE TABLE IF NOT EXISTS`
 * skips existing tables, so these are applied one by one and tolerate
 * "duplicate column".
 */
export const HUB_CHAT_COLUMN_MIGRATIONS: ReadonlyArray<string> = [
  'ALTER TABLE hub_chat_channels ADD COLUMN session_id TEXT',
  // Optional second destination: a Google Chat space the trigger creator
  // posts into through their own Google connection.
  'ALTER TABLE project_chat_triggers ADD COLUMN google_chat_space_id TEXT',
  // Bumped on every reaction or pin change, so a client holding two copies of
  // a message (a history page and a live update) keeps the newer reactions.
  'ALTER TABLE hub_chat_messages ADD COLUMN meta_rev INTEGER NOT NULL DEFAULT 0',
];

/**
 * Adds `hub_chat_channel_digests.window_start` to a table created before the
 * column existed. The reconciler in `schema-reconcile.ts` cannot add it: SQLite
 * refuses `ADD COLUMN ... NOT NULL` without a default, so every digest save
 * threw `no column named window_start`. The column gets an empty default and
 * existing rows are backfilled to their last run, else one default lookback
 * before now (the same start a new digest gets). Idempotent.
 */
export function migrateHubChatDigestsWindowStart(conn: Database.Database): void {
  const cols = conn.prepare(`PRAGMA table_info('hub_chat_channel_digests')`).all() as Array<{
    name: string;
  }>;
  if (cols.length === 0 || cols.some((c) => c.name === 'window_start')) return;
  const lookbackStart = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const hasLastRun = cols.some((c) => c.name === 'last_run_at');
  conn.transaction(() => {
    conn.exec(
      `ALTER TABLE hub_chat_channel_digests ADD COLUMN window_start TEXT NOT NULL DEFAULT ''`,
    );
    conn
      .prepare(
        `UPDATE hub_chat_channel_digests SET window_start = ${
          hasLastRun ? 'COALESCE(last_run_at, ?)' : '?'
        } WHERE window_start = ''`,
      )
      .run(lookbackStart);
  })();
}

export const HUB_CHAT_POST_MIGRATION_SCHEMA = `
  CREATE INDEX IF NOT EXISTS idx_hub_chat_channels_session
    ON hub_chat_channels(session_id) WHERE session_id IS NOT NULL;
`;

/**
 * Full-text index over message bodies; queried by `hub-chat-search.ts`.
 * External-content FTS5 kept in sync by triggers, so every writer is indexed.
 * Soft deletes clear the body, which removes the message via the update
 * trigger.
 */
export const HUB_CHAT_FTS_TABLE = 'hub_chat_messages_fts';
const FTS_TABLE = HUB_CHAT_FTS_TABLE;

const FTS_SCHEMA = `
  CREATE VIRTUAL TABLE ${FTS_TABLE} USING fts5(
    body,
    content='hub_chat_messages',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
  );
`;

const FTS_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS hub_chat_messages_fts_ai AFTER INSERT ON hub_chat_messages BEGIN
    INSERT INTO ${FTS_TABLE}(rowid, body) VALUES (new.rowid, new.body);
  END;
  CREATE TRIGGER IF NOT EXISTS hub_chat_messages_fts_ad AFTER DELETE ON hub_chat_messages BEGIN
    INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, body) VALUES ('delete', old.rowid, old.body);
  END;
  CREATE TRIGGER IF NOT EXISTS hub_chat_messages_fts_au AFTER UPDATE OF body ON hub_chat_messages BEGIN
    INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, body) VALUES ('delete', old.rowid, old.body);
    INSERT INTO ${FTS_TABLE}(rowid, body) VALUES (new.rowid, new.body);
  END;
`;

/**
 * Creates the index and its triggers. A database that already has messages
 * when the index is first created gets them backfilled. Idempotent.
 */
export function applyHubChatSearchIndex(conn: Database.Database): void {
  const exists = conn
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(FTS_TABLE);
  conn.transaction(() => {
    if (!exists) {
      conn.exec(FTS_SCHEMA);
      conn.exec(`INSERT INTO ${FTS_TABLE}(${FTS_TABLE}) VALUES ('rebuild')`);
    }
    conn.exec(FTS_TRIGGERS);
  })();
}
