/**
 * org_todos DDL — kept in its own module so `orgs.ts` (which initialises the
 * orgs DB and applies every schema) can import it without pulling in the full
 * `org-todos-store.ts` (which depends on `orgs.ts` for `getOrgsDb`). Mirrors
 * `user-todos-schema.ts`.
 *
 * An org todo is the shared, organization-wide counterpart to a personal
 * `user_todos` row: it is keyed by `org_id`, lives in the shared orgs.db, and
 * is readable AND writable by every member of the org (there is no per-user
 * ownership boundary — the whole point is a single list the team shares). It
 * is a distinct list, NOT an aggregation of members' personal todos.
 *
 * Columns mirror the personal-todo scheduling fields (status / priority /
 * do_date window) so the shared list looks and behaves like the personal one.
 * The provenance and polymorphic-link columns from `user_todos` are omitted:
 * promote-to-ticket / link-to-entity are per-viewer capture features that do
 * not map onto a shared list.
 *
 *   - status: `open` | `done`. Defaults to `open`.
 *   - priority: `urgent` | `high` | `medium` | `low`, defaulting to `medium`.
 *   - do_date / do_start_at / do_end_at: the day (and optional time window) the
 *     team intends to work the task. A scheduling "do" date, not a hard
 *     deadline (matches `user_todos`).
 *   - position: per-org ordering. New todos append at the end
 *     (`COALESCE(MAX(position), -1) + 1` scoped to the org).
 *   - created_by_user_id: the member who added the todo. Recorded for display
 *     on the shared list; nullable so the apiKey / local-bundled paths (which
 *     have no user id) can still create.
 *
 * The composite index on (org_id, position) serves the hot per-org ordered
 * list read.
 */
export const ORG_TODOS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS org_todos (
    id                 TEXT PRIMARY KEY,
    org_id             TEXT NOT NULL,
    title              TEXT NOT NULL,
    notes              TEXT NOT NULL DEFAULT '',
    status             TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
    priority           TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('urgent','high','medium','low')),
    do_date            TEXT,
    do_start_at        TEXT,
    do_end_at          TEXT,
    position           INTEGER NOT NULL DEFAULT 0,
    created_by_user_id TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_org_todos_org_position ON org_todos(org_id, position);
`;
