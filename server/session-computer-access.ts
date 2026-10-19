/**
 * Session-level access to the persistent desktop computer: which computer a
 * session drives and whether it may drive it right now. Shared by the
 * `computer` tool, the live view and the session switch so organization scope
 * is enforced the same way on each.
 */
import { getActiveOrgId } from './orgs.js';
import {
  organizationSessionAllowsTool,
  organizationSessionOwnerAllowsTool,
} from './organization-capabilities.js';
import {
  resolveDesktopComputerIdentity,
  type DesktopIdentityProject,
  type DesktopIdentityResult,
} from './desktop/desktop-computer-identity.js';

export const ORGANIZATION_COMPUTER_DENIED_MARKDOWN =
  'The `computer` tool is not authorized for this organization agent right now (its tool scope excludes Computer, the agent or organization was disabled or archived, or your access changed). The op did not run.';

export function sessionDesktopComputerIdentity(
  ownerUserId: string | null | undefined,
  agentId: string,
  project: DesktopIdentityProject | null | undefined,
): DesktopIdentityResult {
  return resolveDesktopComputerIdentity({
    ownerUserId,
    agentId,
    project,
    serverId: getActiveOrgId(),
  });
}

/** Agent-driven ops: refused while the CLI context is revoked. Null means allowed. */
export function agentComputerDenial(sessionId: string): string | null {
  return organizationSessionAllowsTool(sessionId, 'computer')
    ? null
    : ORGANIZATION_COMPUTER_DENIED_MARKDOWN;
}

/** Owner-driven access (live view, input, turning the session switch on). */
export function ownerComputerAllowed(sessionId: string): boolean {
  return organizationSessionOwnerAllowsTool(sessionId, 'computer');
}
