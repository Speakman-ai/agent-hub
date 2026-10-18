/** Acting-user authorization for business groups, never the legacy global-key bypass. */
import {
  getBusinessOrganization,
  getBusinessOrganizationRole,
} from './business-organizations-store.js';
import { getMembershipRole } from './memberships-store.js';
import { getAllOrgs, getOrg } from './orgs.js';
import { findProjectForServer } from './project-model.js';
import { assignedProjectIdsForUser, restrictedProjectIds } from './project-members-store.js';
import { canViewProject } from './project-visibility.js';
import { isHubSystemProject } from '../shared/utils/hub.js';
import type { BroadcastEvent } from './event-project-resolver.js';
import type { Role } from './roles.js';
import type { BusinessOrganizationRole, Project } from './types.js';

export interface OrganizationCaller {
  serverId: string;
  userId: string;
  serverRole: Role;
}

export function resolveOrganizationCaller(
  serverId: string,
  userId: string,
): OrganizationCaller | null {
  if (getOrg(serverId)?.mode !== 'local') return null;
  const serverRole = getMembershipRole(userId, serverId);
  return serverRole ? { serverId, userId, serverRole } : null;
}

export function isServerAdministrator(caller: OrganizationCaller): boolean {
  return caller.serverRole === 'Owner' || caller.serverRole === 'Admin';
}

export function organizationAccess(
  caller: OrganizationCaller,
  organizationId: string,
): {
  role: BusinessOrganizationRole | null;
  canView: boolean;
  canManage: boolean;
} {
  const role = getBusinessOrganizationRole(caller.serverId, organizationId, caller.userId);
  const administrator = isServerAdministrator(caller);
  return {
    role,
    canView: administrator || role !== null,
    canManage: administrator || role === 'Owner' || role === 'Admin',
  };
}

/** Reuse the existing project ACL with the acting user's current Server role.
 * Organization roles never contribute to it; neither does a global API key or session header.
 */
export function visibleOrganizationProject(
  caller: OrganizationCaller,
  projectId: string,
): Project | null {
  const project = findProjectForServer(caller.serverId, projectId);
  if (
    !project ||
    isHubSystemProject(project) ||
    project.hidden === true ||
    project.internal === true
  )
    return null;
  const assignedProjectIds = assignedProjectIdsForUser(caller.userId);
  // Legacy project_members rows are keyed only by project ID. A duplicate ID
  // across local Server registries makes that grant ambiguous: never borrow it
  // for cross-Server organization reads. Explicit project ownership and the
  // existing shared-project rules remain valid. Do not rewrite legacy ACLs here.
  if (
    assignedProjectIds.has(projectId) &&
    project.ownerUserId !== caller.userId &&
    getAllOrgs().some(
      (server) =>
        server.mode === 'local' &&
        server.id !== caller.serverId &&
        findProjectForServer(server.id, projectId) !== null,
    )
  )
    assignedProjectIds.delete(projectId);
  const visible = canViewProject(project, {
    userId: caller.userId,
    role: caller.serverRole,
    assignedProjectIds,
    restrictedProjectIds: restrictedProjectIds(),
  });
  return visible ? project : null;
}

/** Minimal revocation messages may reach their former member after archive/removal.
 * They contain only the already-known group identity, never names, counts or project data.
 * All other events require CURRENT membership/administration and current project ACLs.
 */
export function canReadOrganizationEvent(
  data: BroadcastEvent,
  userId: string,
  serverId: string,
): boolean {
  try {
    if (data.serverId !== serverId || typeof data.organizationId !== 'string') return false;
    const caller = resolveOrganizationCaller(serverId, userId);
    if (!caller) return false;
    if (data.type === 'organization_access_revoked') {
      return (
        data.userId === userId &&
        (data.reason === 'archived' || data.reason === 'member_removed') &&
        Object.keys(data).every((key) =>
          ['type', 'serverId', 'organizationId', 'userId', 'reason'].includes(key),
        )
      );
    }
    if (
      !getBusinessOrganization(serverId, data.organizationId) ||
      !organizationAccess(caller, data.organizationId).canView
    )
      return false;
    if (data.projectId !== undefined) {
      return (
        typeof data.projectId === 'string' &&
        visibleOrganizationProject(caller, data.projectId) !== null
      );
    }
    return true;
  } catch {
    return false;
  }
}
