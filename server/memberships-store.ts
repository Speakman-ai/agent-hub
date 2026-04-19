/**
 * Memberships store — Auth Phase 3.
 *
 * Resolves `(user_id, org_id) → Role`. The core of per-org role
 * enforcement: the auth middleware looks up the active-org role via
 * `getMembershipRole` after verifying the JWT, and every org-scoped
 * admin mutation checks/updates membership rows rather than poking the
 * user record.
 */
import { getOrgsDb } from './orgs.js';
import { parseRole, type Role } from './roles.js';

export interface MembershipRow {
  user_id: string;
  org_id: string;
  role: Role;
  created_at: string;
}

/** Combined row used by the `/api/orgs/:id/members` and `/api/auth/users` listings. */
export interface MembershipWithUser {
  userId: string;
  username: string;
  role: Role;
  createdAt: string;
}

/** Return the caller's role within `orgId`, or null if they're not a member. */
export function getMembershipRole(userId: string, orgId: string): Role | null {
  const db = getOrgsDb();
  const row = db
    .prepare('SELECT role FROM memberships WHERE user_id = ? AND org_id = ?')
    .get(userId, orgId) as { role: string } | undefined;
  if (!row) return null;
  return parseRole(row.role);
}

export function createMembership(userId: string, orgId: string, role: Role): void {
  const db = getOrgsDb();
  db.prepare('INSERT OR REPLACE INTO memberships (user_id, org_id, role) VALUES (?, ?, ?)').run(
    userId,
    orgId,
    role,
  );
}

export function deleteMembership(userId: string, orgId: string): void {
  const db = getOrgsDb();
  db.prepare('DELETE FROM memberships WHERE user_id = ? AND org_id = ?').run(userId, orgId);
}

export function setMembershipRole(userId: string, orgId: string, role: Role): void {
  const db = getOrgsDb();
  db.prepare('UPDATE memberships SET role = ? WHERE user_id = ? AND org_id = ?').run(
    role,
    userId,
    orgId,
  );
}

/** Count how many Owners exist in `orgId`. Used to refuse removing the last one. */
export function countOwnersForOrg(orgId: string): number {
  const db = getOrgsDb();
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM memberships WHERE org_id = ? AND role = 'Owner'")
    .get(orgId) as { c: number };
  return row.c;
}

/** Count how many orgs a user belongs to. 0 means we can hard-delete the user. */
export function countMembershipsForUser(userId: string): number {
  const db = getOrgsDb();
  const row = db.prepare('SELECT COUNT(*) AS c FROM memberships WHERE user_id = ?').get(userId) as {
    c: number;
  };
  return row.c;
}

/**
 * List every member of an org, joined with the users table so callers
 * have the username + creation timestamp to render.
 */
export function listMembersForOrg(orgId: string): MembershipWithUser[] {
  const db = getOrgsDb();
  const rows = db
    .prepare(
      `SELECT u.id AS userId, u.username AS username, m.role AS role, m.created_at AS createdAt
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.org_id = ?
       ORDER BY m.created_at ASC`,
    )
    .all(orgId) as Array<{ userId: string; username: string; role: string; createdAt: string }>;
  return rows.map((r) => ({
    userId: r.userId,
    username: r.username,
    role: (parseRole(r.role) ?? 'User') as Role,
    createdAt: r.createdAt,
  }));
}

/** For debugging / cross-org admin UIs (not exposed yet). */
export function listMembershipsForUser(userId: string): MembershipRow[] {
  const db = getOrgsDb();
  const rows = db
    .prepare('SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at ASC')
    .all(userId) as Array<Omit<MembershipRow, 'role'> & { role: string }>;
  return rows.map((r) => ({ ...r, role: (parseRole(r.role) ?? 'User') as Role }));
}
