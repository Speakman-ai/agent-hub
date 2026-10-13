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
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
`;
