/**
 * Project-members store — per-project user assignment (the visibility ACL).
 *
 * Resolves per-project restriction state plus `(project_id, user_id)`
 * assignments that gate who can see a project. The read surface feeds
 * `resolveVisibilityCaller` (`server/project-visibility-middleware.ts`):
 * it needs two cheap, indexed lookups per request — the set of projects a
 * user is assigned to, and the set of projects with an active assignment
 * ACL ("restricted"). The write surface backs the Owner-only management
 * routes under `/api/projects/:projectId/members`.
 *
 * All access goes through the shared `orgs.db` handle so assignments live
 * next to `users` / `memberships` and inherit the ON DELETE CASCADE from
 * the FK on `user_id`. Restriction rows are separate from assignment rows
 * so deleting the last assigned user cannot silently reopen a project.
 */
import { getOrgsDb } from './orgs.js';

export interface ProjectMemberRow {
  userId: string;
  username: string;
  addedBy: string | null;
  createdAt: string;
}

/** Assign `userId` to `projectId`. Idempotent — re-assigning is a no-op. */
export function addProjectMember(projectId: string, userId: string, addedBy: string | null): void {
  const db = getOrgsDb();
  const ensureRestricted = db.prepare(
    `INSERT INTO project_member_restrictions (project_id)
     VALUES (?)
     ON CONFLICT(project_id) DO NOTHING`,
  );
  const insertMember = db.prepare(
    `INSERT INTO project_members (project_id, user_id, added_by)
      VALUES (?, ?, ?)
      ON CONFLICT(project_id, user_id) DO NOTHING`,
  );
  const tx = db.transaction(() => {
    ensureRestricted.run(projectId);
    insertMember.run(projectId, userId, addedBy);
  });
  tx();
}

/** Remove `userId` from `projectId`. Returns true if a row was deleted. */
export function removeProjectMember(projectId: string, userId: string): boolean {
  const db = getOrgsDb();
  const info = db
    .prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?')
    .run(projectId, userId);
  return info.changes > 0;
}

/** True iff `userId` is assigned to `projectId`. */
export function isProjectMember(projectId: string, userId: string): boolean {
  const db = getOrgsDb();
  const row = db
    .prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1')
    .get(projectId, userId);
  return Boolean(row);
}

/** True iff the project has an active assignment ACL. */
export function isProjectRestricted(projectId: string): boolean {
  const db = getOrgsDb();
  const row = db
    .prepare('SELECT 1 FROM project_member_restrictions WHERE project_id = ? LIMIT 1')
    .get(projectId);
  return Boolean(row);
}

/**
 * List every member of a project, joined with `users` for the username so
 * the management UI can render names. Ordered by assignment time.
 */
export function listProjectMembers(projectId: string): ProjectMemberRow[] {
  const db = getOrgsDb();
  const rows = db
    .prepare(
      `SELECT pm.user_id AS userId, u.username AS username,
              pm.added_by AS addedBy, pm.created_at AS createdAt
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = ?
        ORDER BY pm.created_at ASC`,
    )
    .all(projectId) as ProjectMemberRow[];
  return rows;
}

/** The set of project ids `userId` is assigned to. Cheap, index-backed. */
export function assignedProjectIdsForUser(userId: string): Set<string> {
  const db = getOrgsDb();
  const rows = db
    .prepare('SELECT project_id AS projectId FROM project_members WHERE user_id = ?')
    .all(userId) as Array<{ projectId: string }>;
  return new Set(rows.map((r) => r.projectId));
}

/**
 * The set of project ids with an active assignment ACL ("restricted"
 * projects). Projects NOT in this set have no assignment ACL — the
 * back-compat default that avoids an upgrade backfill.
 */
export function restrictedProjectIds(): Set<string> {
  const db = getOrgsDb();
  const rows = db
    .prepare('SELECT project_id AS projectId FROM project_member_restrictions')
    .all() as Array<{ projectId: string }>;
  return new Set(rows.map((r) => r.projectId));
}

/** Drop every assignment and the restriction marker for a project. Called when a project is deleted. */
export function removeAllProjectMembers(projectId: string): number {
  const db = getOrgsDb();
  const deleteMembers = db.prepare('DELETE FROM project_members WHERE project_id = ?');
  const deleteRestriction = db.prepare(
    'DELETE FROM project_member_restrictions WHERE project_id = ?',
  );
  const tx = db.transaction(() => {
    const info = deleteMembers.run(projectId);
    deleteRestriction.run(projectId);
    return info.changes;
  });
  return tx();
}
