/**
 * Server partition of a persistent desktop Computer and browser profile.
 *
 * Both are keyed by (user, agent, project). Project ids are only unique inside
 * one Server's registry, so a regular project's key carries a Server tag:
 * the stored project id becomes `__server_<tag>__<projectId>`. Every resource
 * name derived from the key (Firecracker VM id, container rows, profile rows)
 * is then distinct per Server. User project ids cannot contain `_`, so the
 * prefix cannot collide with a real project id.
 *
 * The `default` Server keeps the plain id. It is the original data partition,
 * so every existing desktop and saved login there keeps working unchanged.
 *
 * Legacy rows written before this scoping record no Server, so they stay with
 * the default Server and are never moved to another one. Which projects exist
 * now cannot prove which Server created a row: a project deleted on one Server
 * and an unrelated one later created with the same id on another would look
 * identical. Rows written from now on carry their Server in the key itself.
 * Organization workspace ids already hash their Server and are left as is.
 */
import { createHash } from 'node:crypto';
import { getActiveOrgId } from '../orgs.js';
import { ORGANIZATION_WORKSPACE_ID_PREFIX } from '../organization-workspace-id.js';

export const DEFAULT_SERVER_ID = 'default';
export const SERVER_PROFILE_PREFIX = '__server_';
const SCOPED = /^__server_([0-9a-f]{32})__(.+)$/;

export function serverProfileTag(serverId: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['server-profile', serverId]))
    .digest('hex')
    .slice(0, 32);
}

export function isServerScopedProfileProjectId(projectId: string): boolean {
  return projectId.startsWith(SERVER_PROFILE_PREFIX);
}

/** The project id a (user, agent, project) desktop or browser profile is stored under. */
export function serverScopedProfileProjectId(serverId: string, projectId: string): string {
  if (
    serverId === DEFAULT_SERVER_ID ||
    projectId.startsWith(ORGANIZATION_WORKSPACE_ID_PREFIX) ||
    isServerScopedProfileProjectId(projectId)
  )
    return projectId;
  return `${SERVER_PROFILE_PREFIX}${serverProfileTag(serverId)}__${projectId}`;
}

export function activeServerProfileProjectId(projectId: string): string {
  return serverScopedProfileProjectId(getActiveOrgId(), projectId);
}

/** Profile key for the active Server. Callers keep the plain project id for display and routing. */
export function activeServerProfileKey(key: {
  userId: string;
  agentId: string;
  projectId: string;
}) {
  return { ...key, projectId: activeServerProfileProjectId(key.projectId) };
}

/** Plain project id of a stored key, and whether it belongs to `serverId`'s partition. */
export function describeProfileProjectId(
  stored: string,
  serverId: string,
): { projectId: string; inServer: boolean } {
  const scoped = SCOPED.exec(stored);
  if (scoped) return { projectId: scoped[2], inServer: scoped[1] === serverProfileTag(serverId) };
  if (stored.startsWith(ORGANIZATION_WORKSPACE_ID_PREFIX))
    return { projectId: stored, inServer: true };
  return { projectId: stored, inServer: serverId === DEFAULT_SERVER_ID };
}
