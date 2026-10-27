/**
 * Google user OAuth connection DDL — kept in its own module so `orgs.ts`
 * (which initialises the orgs DB and applies the schema) can import it without
 * pulling in the full `google-connections-store.ts` (which depends on `orgs.ts`
 * for `getOrgsDb`). Mirrors `user-todos-schema.ts`.
 *
 * Unlike GitHub's connection (six nullable columns on `users`), Google lives in
 * a dedicated table: the token columns are ENCRYPTED at rest via secret-crypto
 * (AES-256-GCM), and a separate table keeps the encrypted blobs off the hot
 * `users` row.
 *
 * One Hub user can link several Google accounts. Each row is one account,
 * keyed by its own `id`; `(user_id, google_sub)` is unique so re-consenting the
 * same Google account updates its row. Exactly one account per user carries
 * `is_default = 1` (enforced by a partial unique index); callers that do not
 * name an account get that one.
 *
 * Columns:
 *   - access_token_enc / refresh_token_enc: `iv:tag:ciphertext` blobs from
 *     `encryptSecret`. NEVER plaintext. Empty string means "not set".
 *   - token_expires_at: ISO timestamp of access-token expiry (Google access
 *     tokens always expire, ~1h). Drives the 5-minute proactive refresh.
 *   - granted_scopes_json: JSON array of the scopes Google actually granted
 *     (incremental authorization grows this set per surface).
 */
import type Database from 'better-sqlite3';

const TABLE_COLUMNS = `
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    google_sub          TEXT NOT NULL,
    google_email        TEXT NOT NULL,
    access_token_enc    TEXT NOT NULL DEFAULT '',
    token_expires_at    TEXT,
    refresh_token_enc   TEXT NOT NULL DEFAULT '',
    granted_scopes_json TEXT NOT NULL DEFAULT '[]',
    is_default          INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
    connected_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, google_sub)
`;

export const GOOGLE_CONNECTIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS google_connections (${TABLE_COLUMNS});
  CREATE INDEX IF NOT EXISTS idx_google_connections_sub ON google_connections(google_sub);
  CREATE INDEX IF NOT EXISTS idx_google_connections_user ON google_connections(user_id, connected_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_google_connections_one_default
    ON google_connections(user_id) WHERE is_default = 1;
`;

/**
 * Rekey a single-account table (`user_id` as PK) to the multi-account shape.
 * Every existing row becomes its user's default account, tokens untouched, so
 * nobody has to re-link. No-op on a fresh DB or one already migrated.
 */
export function migrateGoogleConnectionsToMultiAccount(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(google_connections)`).all() as Array<{
    name: string;
  }>;
  if (cols.length === 0 || cols.some((c) => c.name === 'id')) return;

  db.transaction(() => {
    db.exec(`
      CREATE TABLE google_connections_multi (${TABLE_COLUMNS});
      INSERT INTO google_connections_multi
        (id, user_id, google_sub, google_email, access_token_enc, token_expires_at,
         refresh_token_enc, granted_scopes_json, is_default, connected_at, updated_at)
      SELECT lower(hex(randomblob(16))), user_id, google_sub, google_email,
             access_token_enc, token_expires_at, refresh_token_enc,
             granted_scopes_json, 1, connected_at, updated_at
      FROM google_connections;
      DROP TABLE google_connections;
      ALTER TABLE google_connections_multi RENAME TO google_connections;
    `);
  })();
}
