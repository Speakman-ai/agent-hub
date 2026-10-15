/**
 * notifications DDL: the persisted per-user inbox feed behind the bell (spec
 * STORAGE). Kept in its own module so `orgs.ts` can apply it without importing
 * `notifications-store.ts`, which depends on `orgs.ts` for `getOrgsDb`.
 *
 * Lives in orgs.db next to `users` so a deleted user's rows CASCADE away.
 * `org_id` / `project_id` are plain tags with no FK: a notification must
 * survive its project being deleted until retention prunes it.
 *
 * `source_key` identifies the event that produced the row. The unique
 * (user_id, source_key) index makes a repeated broadcast of the same event a
 * no-op instead of a duplicate inbox entry.
 *
 * Timestamps are ISO-8601 strings written by the store (millisecond precision),
 * not `datetime('now')`, so keyset paging and the retention cutoffs compare one
 * format lexically.
 */
export const NOTIFICATIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS notifications (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id      TEXT,
    project_id  TEXT,
    category    TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    route       TEXT,
    data        TEXT,
    source_key  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    read_at     TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_source ON notifications(user_id, source_key);
  CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read_at);
  CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at);
`;
