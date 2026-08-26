/** orgs.db DDL for per-user skill option selections (non-secret). */

export const USER_SKILL_OPTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS user_skill_options (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  option_name TEXT NOT NULL,
  -- Non-secret enum selection (e.g. dev / prod). Stored plaintext: options
  -- are owner-curated choices, never secrets (that is what credentials are for).
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, skill_id, option_name)
);
CREATE INDEX IF NOT EXISTS idx_uskillopt_user_skill ON user_skill_options(user_id, skill_id);
`;
