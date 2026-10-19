import { isOrganizationSystemProject } from '../shared/utils/hub.js';
import type { OrganizationSessionIdentity } from './organization-session-identity.js';
import type { Project } from './types.js';

export interface OrganizationSessionReader {
  /** Authenticated user id; bypass and anonymous callers have none and are denied. */
  userId: string | null | undefined;
  serverId: string | null | undefined;
  /** Whether the reader owns the session (`sessions.owner_user_id`). */
  ownsSession: boolean;
}

/**
 * The single read rule for a session with a persisted organization identity, shared
 * by HTTP snapshots and WebSocket fan-out. The identity outlives its agent and
 * workspace, so a missing or mismatched workspace denies instead of falling back to
 * project-visibility or bypass paths.
 */
export function canReadOrganizationSession(
  identity: OrganizationSessionIdentity,
  workspace: Project | null | undefined,
  reader: OrganizationSessionReader,
  canReadWorkspace: ((project: Project, userId: string, serverId: string) => boolean) | undefined,
  agentId?: string | null,
): boolean {
  if (!workspace || !isOrganizationSystemProject(workspace)) return false;
  if (workspace.id !== identity.workspace_id) return false;
  if (
    workspace.serverId !== identity.server_id ||
    workspace.organizationId !== identity.organization_id
  )
    return false;
  if (agentId && agentId !== identity.agent_id) return false;
  if (!reader.userId || !reader.serverId || reader.serverId !== identity.server_id) return false;
  if (!reader.ownsSession) return false;
  return canReadWorkspace?.(workspace, reader.userId, reader.serverId) === true;
}
