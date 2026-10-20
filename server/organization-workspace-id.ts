import { createHash } from 'node:crypto';

/** Prefix reserved for hidden organization workspaces. User project ids cannot contain `_`. */
export const ORGANIZATION_WORKSPACE_ID_PREFIX = '__organization_';

/** Deterministic, Server-qualified id of an organization's hidden workspace. */
export function organizationWorkspaceId(serverId: string, organizationId: string): string {
  return `${ORGANIZATION_WORKSPACE_ID_PREFIX}${createHash('sha256')
    .update(JSON.stringify([serverId, organizationId]))
    .digest('hex')}__`;
}
