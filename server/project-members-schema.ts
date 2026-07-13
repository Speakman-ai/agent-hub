/**
 * project_members DDL — kept in its own module so `orgs.ts` (which
 * initialises the orgs DB and applies every schema) can import it without
 * pulling in the full `project-members-store.ts`. Mirrors
 * `user-todos-schema.ts` / `google-connections-schema.ts`.
 *
 * `project_member_restrictions` records that a project has an explicit
 * assignment ACL. `project_members` records the assigned users. Keeping
 * restriction state separate from member rows matters because user deletion
 * cascades member rows: deleting the final assigned user must not silently
 * reopen a restricted shared project to the whole org.
 *
 * A project missing from `project_member_restrictions` has no assignment ACL:
 * shared projects are org-visible and private projects are owner-only. Once a
 * restriction row exists, only assigned users (plus project owner / org Owner
 * bypasses defined in `server/project-visibility.ts`) can see it. The
 * restriction survives member deletion until the project itself is deleted.
 *
 * Keyed on (project_id, user_id). `user_id` FKs `users(id)` with ON DELETE
 * CASCADE so deleting a user drops their assignments automatically. There
 * is NO FK on `project_id` — projects live in `projects.json`, not in
 * orgs.db, so the project route layer prunes rows on project delete
 * (`deleteProjectScopedRows`). `added_by` records the Owner who made the
 * assignment (SET NULL if that user is later deleted).
 */
export const PROJECT_MEMBERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS project_member_restrictions (
    project_id  TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS project_members (
    project_id  TEXT NOT NULL,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

  INSERT OR IGNORE INTO project_member_restrictions (project_id)
    SELECT DISTINCT project_id FROM project_members;
`;
