/**
 * user_todos DDL — kept in its own module so `orgs.ts` (which initialises the
 * orgs DB and applies every schema) can import it without pulling in the full
 * `user-todos-store.ts` (which depends on `orgs.ts` for `getOrgsDb`). Mirrors
 * `google-connections-schema.ts` and `mcp-servers-schema.ts`.
 *
 * Cross-project personal todos live in the shared orgs.db, keyed by `user_id`,
 * NOT on any project board (spec TODO-MODEL). A todo is a per-user, global
 * capture primitive — reusing kanban_cards on a synthetic per-user board was
 * rejected because it couples personal capture to project RBAC.
 *
 * Columns:
 *   - status: `open` | `done`. Defaults to `open`.
 *   - due_at: optional ISO timestamp of when the todo is due.
 *   - position: per-user ordering. New todos append at the end
 *     (`COALESCE(MAX(position), -1) + 1` scoped to the owner).
 *   - source_type / source_id / source_meta: capture provenance (spec
 *     CAPTURE-PROVENANCE). `source_type` is `manual` for hand-created todos,
 *     `email` / `calendar` when captured from the Google Workspace surfaces.
 *     `source_meta` is a JSON blob preserving a deep link back to the original
 *     Gmail message / Calendar event so the dashboard can reopen it.
 *   - linked_card_id / linked_project_id: set when the todo is promoted to a
 *     project kanban card (spec TODO-TO-TICKET). The todo persists alongside
 *     its ticket; the two entities are joined by this link.
 *
 * The composite index on (user_id, position) serves the hot per-user ordered
 * list read.
 */
export const USER_TODOS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS user_todos (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title             TEXT NOT NULL,
    notes             TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
    due_at            TEXT,
    position          INTEGER NOT NULL DEFAULT 0,
    source_type       TEXT NOT NULL DEFAULT 'manual' CHECK(source_type IN ('manual','email','calendar')),
    source_id         TEXT,
    source_meta       TEXT,
    linked_card_id    TEXT,
    linked_project_id TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_user_todos_user_position ON user_todos(user_id, position);
`;
