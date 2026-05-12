/**
 * Worktree-preview secrets schema.
 *
 * Per-project key/value pairs merged into the env when the preview
 * runtime spawns a dev server (see `preview-runtime.ts`). Values are
 * stored at rest with the same AES-256-GCM helper used for skill
 * credentials and Slack tokens (`secret-crypto.ts`).
 *
 * Two-kind model:
 *
 *   - `plain`  — values returned in clear on `GET`. Useful for
 *                non-sensitive config flags the user wants to set per
 *                project (FEATURE_X=on, NODE_ENV=development, etc.).
 *                Still encrypted at rest so the DB file alone never
 *                leaks user config to an attacker with read access to
 *                the data dir.
 *   - `secret` — values masked on `GET` (returns `MASK` constant) and
 *                only ever decrypted in two paths:
 *                  (a) the preview spawn merge (no caller-facing read)
 *                  (b) a fresh `PUT` that overwrites the row entirely
 *                The store does not expose a "reveal" endpoint.
 *
 * Why a dedicated table rather than reusing `user_skill_credentials`?
 *   - Different scope: secrets here are scoped to (project_id), not
 *     (user_id, skill_id, key_name). The Cursor parity we're matching
 *     is per-repo not per-user.
 *   - Different lifecycle: removing a user must not delete the
 *     project's preview env; removing a project takes the secrets
 *     with it.
 *
 * The `audit` table is intentionally separate from
 * `user_skill_credential_audit` so the project-scoped event log can be
 * filtered/queried independently of the user-scoped one. It captures
 * three event kinds: `upsert`, `delete`, and `read` — the third is
 * appended by the runtime when a spawn merges secrets into the child
 * env, so operators can prove (or disprove) which preview runs touched
 * which keys.
 */
export const WORKTREE_PREVIEW_SECRETS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS worktree_preview_secrets (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL,
    key               TEXT NOT NULL,
    -- iv:tag:ciphertext (base64 triple) — produced by encryptSecret().
    value_ciphertext  TEXT NOT NULL,
    -- Kept as separate columns alongside the combined ciphertext blob so
    -- a future tooling pass can inspect the IV/tag halves without
    -- splitting the blob. We populate them at write time and never read
    -- them at decrypt time (decryptSecret reparses value_ciphertext).
    value_iv          TEXT NOT NULL,
    value_tag         TEXT NOT NULL,
    kind              TEXT NOT NULL CHECK(kind IN ('plain','secret')),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, key)
  );
  CREATE INDEX IF NOT EXISTS idx_worktree_preview_secrets_project
    ON worktree_preview_secrets(project_id);

  CREATE TABLE IF NOT EXISTS worktree_preview_secret_audit (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    -- Pipe-delimited list of keys touched in one event. We keep them in
    -- a single row rather than one row per key so the read-audit path
    -- (which fires once per spawn) doesn't pay an O(keys) INSERT cost.
    keys            TEXT NOT NULL,
    action          TEXT NOT NULL CHECK(action IN ('upsert','delete','read')),
    actor_user_id   TEXT,
    session_id      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_worktree_preview_secret_audit_project
    ON worktree_preview_secret_audit(project_id, created_at);
`;
