/**
 * Which persistent computer a chat session drives. Every path that turns a
 * session into a DesktopComputerKey (the `computer` tool, the live view and
 * human input) goes through here so they can never disagree.
 *
 * Regular projects use (user, agent, Server-scoped project): see
 * server-profile-scope.ts, which keeps the default Server's ids unchanged. An
 * organization agent's project id is its hidden workspace id, a hash of
 * (Server, organization) in a namespace user project ids cannot enter, so the
 * key resolves to (Server, user, organization, agent) and the backend kind is
 * added by the store. The workspace is checked against that derivation here,
 * so a hand-edited or misfiled workspace can never borrow another Server's or
 * organization's disk and browser profile.
 */
import {
  ORGANIZATION_WORKSPACE_ID_PREFIX,
  organizationWorkspaceId,
} from '../organization-workspace-id.js';
import type { DesktopComputerKey } from './desktop-runtime.js';
import {
  isServerScopedProfileProjectId,
  serverScopedProfileProjectId,
} from './server-profile-scope.js';

export interface DesktopIdentityProject {
  id: string;
  workspaceKind?: string | null;
  organizationId?: string | null;
  serverId?: string | null;
  agents?: ReadonlyArray<{ id: string }>;
}

export interface DesktopIdentityInput {
  ownerUserId: string | null | undefined;
  agentId: string;
  project: DesktopIdentityProject | null | undefined;
  /** The Server partition the session lives in (the active Server). */
  serverId: string;
}

export type DesktopIdentityResult =
  | { ok: true; key: DesktopComputerKey }
  | { ok: false; reason: string };

export const DESKTOP_NO_OWNER_REASON =
  'This session has no owning user or project, and a desktop belongs to one (user, agent, project). The op did not run.';
export const DESKTOP_ORG_IDENTITY_REASON =
  'This organization workspace does not match its Server and organization, so it has no desktop. The op did not run.';

export function resolveDesktopComputerIdentity(input: DesktopIdentityInput): DesktopIdentityResult {
  const { ownerUserId, agentId, project } = input;
  if (!ownerUserId || !project?.id || !agentId)
    return { ok: false, reason: DESKTOP_NO_OWNER_REASON };
  const organizationMarked =
    project.workspaceKind === 'organization' ||
    Boolean(project.organizationId) ||
    project.id.startsWith(ORGANIZATION_WORKSPACE_ID_PREFIX);
  if (organizationMarked) {
    if (
      project.workspaceKind !== 'organization' ||
      !project.organizationId ||
      !project.serverId ||
      project.serverId !== input.serverId ||
      project.id !== organizationWorkspaceId(project.serverId, project.organizationId) ||
      (project.agents && !project.agents.some((a) => a.id === agentId))
    )
      return { ok: false, reason: DESKTOP_ORG_IDENTITY_REASON };
  }
  // A real project id never carries the Server tag; refuse one rather than alias another key.
  if (!organizationMarked && isServerScopedProfileProjectId(project.id))
    return { ok: false, reason: DESKTOP_NO_OWNER_REASON };
  const projectId = organizationMarked
    ? project.id
    : serverScopedProfileProjectId(input.serverId, project.id);
  return { ok: true, key: { userId: ownerUserId, agentId, projectId } };
}
