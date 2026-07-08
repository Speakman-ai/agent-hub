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
 *   - priority: `urgent` | `high` | `medium` | `low`, defaulting to `medium`.
 *     Reuses the kanban-card priority enum so a promote maps 1:1 (spec
 *     TODO-MODEL / TODO-TO-TICKET).
 *   - do_date: the day the user intends to WORK the task (a scheduling "do"
 *     date, NOT a hard deadline), with an optional do_start_at / do_end_at
 *     time window. See `due_at` below for the deadline distinction.
 *   - due_at: retained for back-compat. `due_at` predates the do_date model and
 *     is kept read/write so the existing REST surface keeps working, but it is
 *     NOT the scheduling field going forward — do_date is. A distinct hard
 *     deadline can be re-introduced later if a real due date is needed.
 *   - position: per-user ordering. New todos append at the end
 *     (`COALESCE(MAX(position), -1) + 1` scoped to the owner).
 *   - source_type / source_id / source_meta: capture provenance (spec
 *     CAPTURE-PROVENANCE). `source_type` is `manual` for hand-created todos,
 *     `email` / `calendar` when captured from the Google Workspace surfaces.
 *     `source_meta` is a JSON blob preserving a deep link back to the original
 *     Gmail message / Calendar event so the dashboard can reopen it.
 *   - linked_type / linked_id / linked_project_id: the polymorphic link to an
 *     existing entity the todo is associated with (spec TODO-TO-TICKET).
 *     `linked_type` is `card` | `epic` | `session`; `linked_id` is that
 *     entity's id; `linked_project_id` scopes a project-bound target (card /
 *     epic). A promote stamps `{card, cardId, projectId}`; a plain link can
 *     also target an epic or a session. The todo persists alongside its
 *     target; the two entities are joined by this link.
 *   - linked_card_id: retained for back-compat only. Superseded by
 *     linked_type/linked_id. The additive migration backfills
 *     `linked_type='card', linked_id=linked_card_id` for pre-existing rows;
 *     the store keeps it in sync when stamping a card link. New readers should
 *     use linked_type/linked_id.
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
    priority          TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('urgent','high','medium','low')),
    do_date           TEXT,
    do_start_at       TEXT,
    do_end_at         TEXT,
    due_at            TEXT,
    position          INTEGER NOT NULL DEFAULT 0,
    source_type       TEXT NOT NULL DEFAULT 'manual' CHECK(source_type IN ('manual','email','calendar')),
    source_id         TEXT,
    source_meta       TEXT,
    linked_type       TEXT CHECK(linked_type IN ('card','epic','session')),
    linked_id         TEXT,
    linked_card_id    TEXT,
    linked_project_id TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_user_todos_user_position ON user_todos(user_id, position);
`;
