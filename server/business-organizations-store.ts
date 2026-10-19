import { revalidateOrganizationAccess } from './organization-spawn-policy.js';
/** Persistence only. Callers must authorize the acting user and project ACLs
 * before using this store; organization membership does not grant project
 * access. Every operation requires an explicit legacy Server partition ID.
 */
import { randomUUID } from 'crypto';
import { getOrg, getOrgsDb } from './orgs.js';
import { findProjectForServer } from './project-model.js';
import { isInternalSystemProject } from '../shared/utils/hub.js';
import type {
  BusinessOrganizationMemberRow,
  BusinessOrganizationRole,
  BusinessOrganizationRow,
} from './types.js';

export function getBusinessOrganization(
  serverId: string,
  organizationId: string,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): BusinessOrganizationRow | null {
  return (
    (getOrgsDb()
      .prepare(
        `SELECT * FROM business_organizations WHERE server_id = ? AND id = ?
         ${includeArchived ? '' : 'AND archived_at IS NULL'}`,
      )
      .get(serverId, organizationId) as BusinessOrganizationRow | undefined) ?? null
  );
}

export function listBusinessOrganizations(serverId: string): BusinessOrganizationRow[] {
  return getOrgsDb()
    .prepare(
      `SELECT * FROM business_organizations
       WHERE server_id = ? AND archived_at IS NULL ORDER BY created_at, id`,
    )
    .all(serverId) as BusinessOrganizationRow[];
}

function withActiveOrganization<T>(serverId: string, organizationId: string, write: () => T): T {
  // Serialize the active-state check with the write, including against other
  // processes using orgs.db. An archive cannot race a new link or membership.
  const result = getOrgsDb()
    .transaction(() => {
      if (!getBusinessOrganization(serverId, organizationId)) {
        throw new Error('Organization not found');
      }
      return write();
    })
    .immediate();
  revalidateOrganizationAccess();
  return result;
}

function organizationName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Organization name is required');
  return trimmed;
}

/** Empty organizations are valid. Creator membership and the row commit together. */
export function createBusinessOrganization({
  serverId,
  name,
  createdBy,
}: {
  serverId: string;
  name: string;
  createdBy: string;
}): BusinessOrganizationRow {
  if (getOrg(serverId)?.mode !== 'local') throw new Error('Server not found');
  const db = getOrgsDb();
  return db.transaction(() => {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO business_organizations (server_id, id, name, created_by) VALUES (?, ?, ?, ?)`,
    ).run(serverId, id, organizationName(name), createdBy);
    // FK to memberships also requires the creator to belong to this Server.
    setBusinessOrganizationMember(serverId, id, createdBy, 'Owner');
    return getBusinessOrganization(serverId, id)!;
  })();
}

export function renameBusinessOrganization(
  serverId: string,
  organizationId: string,
  name: string,
): BusinessOrganizationRow {
  return withActiveOrganization(serverId, organizationId, () => {
    getOrgsDb()
      .prepare(
        `UPDATE business_organizations SET name = ?, updated_at = datetime('now')
       WHERE server_id = ? AND id = ? AND archived_at IS NULL`,
      )
      .run(organizationName(name), serverId, organizationId);
    return getBusinessOrganization(serverId, organizationId)!;
  });
}

/** Soft-delete only: retain the canonical row and all user-owned session history.
 * Future organization workspace/runtime lifecycle must use this archived state
 * to deny access and dispatch; this store never deletes workspace or project data.
 */
export function archiveBusinessOrganization(serverId: string, organizationId: string): boolean {
  const db = getOrgsDb();
  const result = db.transaction(() => {
    const changed = db
      .prepare(
        `UPDATE business_organizations SET archived_at = datetime('now'), updated_at = datetime('now')
         WHERE server_id = ? AND id = ? AND archived_at IS NULL`,
      )
      .run(serverId, organizationId).changes;
    if (!changed) return false;
    db.prepare(
      'DELETE FROM business_organization_projects WHERE server_id = ? AND organization_id = ?',
    ).run(serverId, organizationId);
    db.prepare(
      `INSERT OR IGNORE INTO business_organization_archived_members (server_id, organization_id, user_id)
       SELECT server_id, organization_id, user_id FROM business_organization_members
        WHERE server_id = ? AND organization_id = ?`,
    ).run(serverId, organizationId);
    db.prepare(
      'DELETE FROM business_organization_members WHERE server_id = ? AND organization_id = ?',
    ).run(serverId, organizationId);
    return true;
  })();
  revalidateOrganizationAccess();
  return result;
}

/** Validate in the selected Server's registry, never against an unscoped ID. */
export function attachBusinessOrganizationProject(
  serverId: string,
  organizationId: string,
  projectId: string,
): boolean {
  return withActiveOrganization(serverId, organizationId, () => {
    const project = findProjectForServer(serverId, projectId);
    if (
      !project ||
      isInternalSystemProject(project) ||
      project.hidden === true ||
      project.internal === true
    ) {
      throw new Error('Project not found');
    }
    return (
      getOrgsDb()
        .prepare(
          `INSERT INTO business_organization_projects (server_id, organization_id, project_id)
       VALUES (?, ?, ?) ON CONFLICT(server_id, organization_id, project_id) DO NOTHING`,
        )
        .run(serverId, organizationId, projectId).changes > 0
    );
  });
}

/** No project lookup on detach: stale links must remain removable. */
export function detachBusinessOrganizationProject(
  serverId: string,
  organizationId: string,
  projectId: string,
): boolean {
  return withActiveOrganization(
    serverId,
    organizationId,
    () =>
      getOrgsDb()
        .prepare(
          `DELETE FROM business_organization_projects
       WHERE server_id = ? AND organization_id = ? AND project_id = ?`,
        )
        .run(serverId, organizationId, projectId).changes > 0,
  );
}

export function listBusinessOrganizationProjectIds(
  serverId: string,
  organizationId: string,
): string[] {
  if (!getBusinessOrganization(serverId, organizationId)) return [];
  const rows = getOrgsDb()
    .prepare(
      `SELECT project_id FROM business_organization_projects
       WHERE server_id = ? AND organization_id = ? ORDER BY project_id`,
    )
    .all(serverId, organizationId) as Array<{ project_id: string }>;
  return rows.map((row) => row.project_id);
}

export function listBusinessOrganizationsForProject(
  serverId: string,
  projectId: string,
): BusinessOrganizationRow[] {
  return getOrgsDb()
    .prepare(
      `SELECT o.* FROM business_organization_projects p
       JOIN business_organizations o ON o.server_id = p.server_id AND o.id = p.organization_id
       WHERE p.server_id = ? AND p.project_id = ? AND o.archived_at IS NULL ORDER BY o.id`,
    )
    .all(serverId, projectId) as BusinessOrganizationRow[];
}

/** Used by both project deletion and the deleted-owner private-project sweep.
 * Failures propagate so a reused project ID cannot inherit stale links.
 */
export function removeBusinessOrganizationProjectLinks(
  serverId: string,
  projectId: string,
): number {
  const changes = getOrgsDb()
    .prepare('DELETE FROM business_organization_projects WHERE server_id = ? AND project_id = ?')
    .run(serverId, projectId).changes;
  revalidateOrganizationAccess();
  return changes;
}

export function setBusinessOrganizationMember(
  serverId: string,
  organizationId: string,
  userId: string,
  role: BusinessOrganizationRole,
): void {
  withActiveOrganization(serverId, organizationId, () => {
    if (role !== 'Owner') requireAnotherOwner(serverId, organizationId, userId);
    getOrgsDb()
      .prepare(
        `INSERT INTO business_organization_members (server_id, organization_id, user_id, role)
       VALUES (?, ?, ?, ?) ON CONFLICT(server_id, organization_id, user_id)
       DO UPDATE SET role = excluded.role`,
      )
      .run(serverId, organizationId, userId, role);
  });
}

export function removeBusinessOrganizationMember(
  serverId: string,
  organizationId: string,
  userId: string,
): boolean {
  return withActiveOrganization(serverId, organizationId, () => {
    requireAnotherOwner(serverId, organizationId, userId);
    return (
      getOrgsDb()
        .prepare(
          `DELETE FROM business_organization_members
       WHERE server_id = ? AND organization_id = ? AND user_id = ?`,
        )
        .run(serverId, organizationId, userId).changes > 0
    );
  });
}

export class LastOrganizationOwnerError extends Error {
  constructor() {
    super('Organization must retain an Owner');
  }
}

/** Called within the immediate write transaction so concurrent demotions cannot orphan a group. */
function requireAnotherOwner(serverId: string, organizationId: string, userId: string): void {
  const owners = listBusinessOrganizationMembers(serverId, organizationId).filter(
    (member) => member.role === 'Owner',
  );
  if (owners.length === 1 && owners[0].user_id === userId) {
    throw new LastOrganizationOwnerError();
  }
}

export function getBusinessOrganizationRole(
  serverId: string,
  organizationId: string,
  userId: string,
): BusinessOrganizationRole | null {
  const row = getOrgsDb()
    .prepare(
      `SELECT m.role FROM business_organization_members m
      JOIN business_organizations o ON o.server_id = m.server_id AND o.id = m.organization_id
      WHERE m.server_id = ? AND m.organization_id = ? AND m.user_id = ? AND o.archived_at IS NULL`,
    )
    .get(serverId, organizationId, userId) as { role: BusinessOrganizationRole } | undefined;
  return row?.role ?? null;
}

/** True when the user was a member at the moment the organization was archived. */
export function wasBusinessOrganizationMemberAtArchive(
  serverId: string,
  organizationId: string,
  userId: string,
): boolean {
  return !!getOrgsDb()
    .prepare(
      `SELECT 1 FROM business_organization_archived_members a
        JOIN business_organizations o ON o.server_id = a.server_id AND o.id = a.organization_id
       WHERE a.server_id = ? AND a.organization_id = ? AND a.user_id = ?
         AND o.archived_at IS NOT NULL`,
    )
    .get(serverId, organizationId, userId);
}

export function listBusinessOrganizationMembers(
  serverId: string,
  organizationId: string,
): BusinessOrganizationMemberRow[] {
  if (!getBusinessOrganization(serverId, organizationId)) return [];
  return getOrgsDb()
    .prepare(
      `SELECT * FROM business_organization_members
       WHERE server_id = ? AND organization_id = ? ORDER BY user_id`,
    )
    .all(serverId, organizationId) as BusinessOrganizationMemberRow[];
}
