import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { getActiveOrgId } from './orgs.js';
import { getBusinessOrganizationRole } from './business-organizations-store.js';
import { resolveOrganizationCaller } from './business-organizations-access.js';
import { findAgent, getProjectDataDir } from './project-model.js';
import { isOrganizationSystemProject } from '../shared/utils/hub.js';
import { resolveEffectiveEngineAndModel } from './effective-model.js';
import { setSessionOwner } from './session-ownership.js';
import { getDb } from './db.js';
import { recordOrganizationSessionIdentity } from './organization-session-identity.js';
import {
  resolveOrganizationSessionAuthority,
  organizationContextEpoch,
} from './organization-capabilities.js';
import type { AppConfig, SessionRow, Stmts } from './types.js';

export function organizationAgentForUser(
  serverId: string,
  organizationId: string,
  agentId: string,
  userId: string,
) {
  const found = findAgent(agentId);
  if (
    serverId !== getActiveOrgId() ||
    !found ||
    !isOrganizationSystemProject(found.project) ||
    found.project.organizationId !== organizationId ||
    found.project.serverId !== serverId ||
    found.project.archivedAt ||
    !found.agent.organizationScope?.enabled ||
    found.agent.organizationScope.archivedAt ||
    !resolveOrganizationCaller(serverId, userId) ||
    !getBusinessOrganizationRole(serverId, organizationId, userId)
  )
    return null;
  return found;
}

export function createOrganizationSession(args: {
  serverId: string;
  organizationId: string;
  agentId: string;
  userId: string;
  stmts: Stmts;
  config: AppConfig;
  name?: string;
}): SessionRow {
  const found = organizationAgentForUser(
    args.serverId,
    args.organizationId,
    args.agentId,
    args.userId,
  );
  if (!found) throw new Error('Organization agent unavailable');
  const { engine, model } = resolveEffectiveEngineAndModel(args.config, {
    agentId: found.agent.id,
    agentEngine: found.agent.engine,
    agentModel: found.agent.model,
    ownerUserId: args.userId,
    projectMode: 'workflow',
  });
  const id = randomUUID();
  return getDb().transaction(() => {
    args.stmts.createSession.run(
      id,
      found.agent.id,
      args.name || found.agent.name,
      engine,
      model,
      0,
      0,
      1,
    );
    setSessionOwner(id, args.userId);
    args.stmts.updateSessionMode.run('consult', id);
    recordOrganizationSessionIdentity(id, {
      server_id: args.serverId,
      organization_id: args.organizationId,
      workspace_id: found.project.id,
      agent_id: found.agent.id,
    });
    return args.stmts.getSession.get(id) as SessionRow;
  })();
}

/** Cwd is private to user, agent and authorization epoch. Old files cannot reenter a fresh context.
 * This is context isolation, not a filesystem sandbox for an unrestricted host CLI. */
export function organizationSessionCwd(sessionId: string): string {
  const authority = resolveOrganizationSessionAuthority(sessionId);
  const owner = createHash('sha256').update(authority.userId).digest('hex');
  const agent = createHash('sha256').update(authority.agentId).digest('hex');
  const cwd = path.join(
    getProjectDataDir(authority.workspaceId),
    'users',
    owner,
    agent,
    organizationContextEpoch(sessionId),
  );
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return cwd;
}
