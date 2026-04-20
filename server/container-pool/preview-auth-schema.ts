/**
 * Preview-URL auth — SQLite schema (W2).
 *
 * Backs the "Preview URLs behind GitHub OAuth + magic-link fallback"
 * subsystem described in the wiki page *Container Pool — PR Envs +
 * Scaffolding* (W2 card).
 *
 * Two tables:
 *
 *   preview_magic_links
 *     One row per issued magic-link token. `token_hash` is the PRIMARY
 *     KEY: we only ever store the sha256 of the token, never the
 *     plaintext. When a user hits `/?mlk=<token>`, the middleware hashes
 *     the incoming token and looks it up; a mismatch is a miss. The link
 *     is scoped to exactly one PR (`pr_number`) and self-expires at
 *     `expires_at` (UTC, ISO-8601). `revoked_at` lets an operator burn a
 *     link early without having to DELETE the row.
 *
 *   preview_auth_sessions
 *     Signed-cookie auth is authoritative, but we keep a server-side
 *     session row for revocation + audit (who logged in, when, via which
 *     flow). Deleting the row invalidates the cookie via `session_id`
 *     lookup. PR scope is null for OAuth sessions (org-member → access
 *     any PR env) and set for magic-link sessions (locked to one PR).
 *
 * Schema is exported as a string so both the production DB bootstrap
 * (server/db.ts) and unit tests (`:memory:` DB) can apply it identically
 * with no drift — same pattern as POOL_SCHEMA / PORT_POOL_SCHEMA.
 */

export const PREVIEW_AUTH_SCHEMA = `
  -- Magic-link tokens — hashed at rest. Lookup path:
  --   incoming token → sha256 → equality match on token_hash PK.
  -- TTL is enforced at query time; a cron reaper can also DELETE expired
  -- rows, but the middleware does not rely on that.
  CREATE TABLE IF NOT EXISTS preview_magic_links (
    token_hash   TEXT PRIMARY KEY,
    pr_number    INTEGER NOT NULL,
    expires_at   TEXT NOT NULL,
    created_by   TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_preview_magic_links_pr
    ON preview_magic_links(pr_number);
  CREATE INDEX IF NOT EXISTS idx_preview_magic_links_expires_at
    ON preview_magic_links(expires_at);

  -- Preview auth sessions — issued after OAuth org-member check or magic
  -- link redemption. The cookie carries (session_id, hmac) — hmac is
  -- verified first, then the session_id is looked up here to confirm
  -- it hasn't been revoked. pr_number is NULL for org-member sessions
  -- (access any preview host) and set for magic-link sessions (scoped
  -- to exactly one PR env).
  CREATE TABLE IF NOT EXISTS preview_auth_sessions (
    session_id   TEXT PRIMARY KEY,
    kind         TEXT NOT NULL CHECK(kind IN ('oauth','magic_link')),
    github_login TEXT,
    pr_number    INTEGER,
    expires_at   TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_preview_auth_sessions_expires_at
    ON preview_auth_sessions(expires_at);
`;
