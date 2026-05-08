/** orgs.db DDL for per-user skill credential storage + audit rows. */

export const USER_SKILL_CREDENTIALS_SCHEMA = `
CREATE TABLE IF NOT EXISTS user_skill_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  key_name TEXT NOT NULL,
  value_enc TEXT NOT NULL,
  -- Pre-computed last-4 mask (e.g. "••••a1b2"). Populated at upsert time so
  -- the list path can render previews without an O(n) AES decrypt sweep on
  -- every GET /api/auth/me/skill-credentials. Nullable for backward
  -- compatibility with rows written before the column existed; rowToMasked
  -- falls back to a one-time decrypt + lazy backfill in that case.
  masked_preview TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  UNIQUE(user_id, skill_id, key_name)
);
CREATE INDEX IF NOT EXISTS idx_uskillcred_user_skill ON user_skill_credentials(user_id, skill_id);

CREATE TABLE IF NOT EXISTS user_skill_credential_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  key_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('upsert','delete')),
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_uskillcred_audit_user ON user_skill_credential_audit(user_id, created_at);
`;
