/**
 * Google user OAuth connection DDL — kept in its own module so `orgs.ts`
 * (which initialises the orgs DB and applies the schema) can import it without
 * pulling in the full `google-connections-store.ts` (which depends on `orgs.ts`
 * for `getOrgsDb`). Mirrors `mcp-servers-schema.ts`.
 *
 * Unlike GitHub's connection (six nullable columns on `users`), Google lives in
 * a dedicated table: the token columns are ENCRYPTED at rest via secret-crypto
 * (AES-256-GCM), and a separate table keeps the encrypted blobs off the hot
 * `users` row. The relationship is still strictly 1:1, so `user_id` is the
 * primary key.
 *
 * Columns:
 *   - access_token_enc / refresh_token_enc: `iv:tag:ciphertext` blobs from
 *     `encryptSecret`. NEVER plaintext. Empty string means "not set".
 *   - token_expires_at: ISO timestamp of access-token expiry (Google access
 *     tokens always expire, ~1h). Drives the 5-minute proactive refresh.
 *   - granted_scopes_json: JSON array of the scopes Google actually granted
 *     (incremental authorization grows this set per surface).
 */
export const GOOGLE_CONNECTIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS google_connections (
    user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    google_sub          TEXT NOT NULL,
    google_email        TEXT NOT NULL,
    access_token_enc    TEXT NOT NULL DEFAULT '',
    token_expires_at    TEXT,
    refresh_token_enc   TEXT NOT NULL DEFAULT '',
    granted_scopes_json TEXT NOT NULL DEFAULT '[]',
    connected_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_google_connections_sub ON google_connections(google_sub);
`;
