/**
 * orgs.db DDL for per-user engine-credential audit rows.
 *
 * Parallels `user_skill_credential_audit` (see
 * `skill-credentials-schema.ts`). One row per write to a per-user engine
 * credential column (`users.{anthropic_api_key, claude_code_oauth_token,
 * cursor_api_key, gemini_api_key, codex_api_key, grok_api_key}`); one row per delete
 * (write of empty / null that clears a previously-set field).
 *
 * The `engine` + `field` split lets a single PUT of `claude-auth` that
 * touches both `anthropicApiKey` and `claudeCodeOAuthToken` emit two
 * audit rows — the operator needs to be able to attribute "which secret
 * rotated when" at the field level, not just the engine level.
 *
 * `actor_user_id` is who *performed* the write; for the v1 routes that's
 * always the same as `user_id` (you can only PUT your own credentials),
 * but keeping the column distinct matches the skill-credential precedent
 * and leaves room for a future admin-acting-on-behalf-of-user surface
 * without a schema migration.
 */
export const AUTH_CREDENTIAL_AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS user_engine_auth_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  engine TEXT NOT NULL CHECK(engine IN ('claude','cursor','gemini','codex','grok')),
  field TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('upsert','delete')),
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_uengineauth_audit_user ON user_engine_auth_audit(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_uengineauth_audit_engine ON user_engine_auth_audit(engine, created_at);
`;
