/** Private, attributable memory. Shared workspace MEMORY.md is never injected into org turns.
 * Records are keyed by Server, organization, user, agent and project link generation, and are
 * pruned from storage on every access mutation, so unlink, access loss or scope narrowing
 * removes them even if access later returns. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { findProjectForServer, getProjectDataDir } from './project-model.js';
import { getActiveOrgId } from './orgs.js';
import { getDb } from './db.js';
import { listBusinessOrganizationProjectLinks } from './business-organizations-store.js';
import {
  currentOrganizationAuthority,
  onOrganizationContextInvalidated,
  resolveOrganizationSessionAuthority,
} from './organization-capabilities.js';
import { organizationSessionIdentity } from './organization-session-identity.js';
import { registerOrganizationAccessRevalidator } from './organization-spawn-policy.js';
import { redact } from './organization-context.js';

export interface OrganizationMemory {
  id: string;
  serverId: string;
  organizationId: string;
  agentId: string;
  projectId: string;
  sourceRecord: string;
  content: string;
  timestamp: string;
}
interface StoredMemory extends OrganizationMemory {
  linkId: string;
  configVersion: string;
}
type Authority = NonNullable<ReturnType<typeof currentOrganizationAuthority>>;

/** The single validity rule, shared by read and prune: a record is usable only under the
 * exact authority generation that wrote it (agent configuration, scope, tools, roles,
 * credentials) and the same link generation of a still-authorized source project. */
function isCurrent(record: StoredMemory, authority: Authority, links: Map<string, string>) {
  return (
    record.serverId === authority.serverId &&
    record.organizationId === authority.organizationId &&
    record.agentId === authority.agentId &&
    authority.tools.includes('projects:read') &&
    authority.projectIds.includes(record.projectId) &&
    !!record.linkId &&
    links.get(record.projectId) === record.linkId &&
    !!record.configVersion &&
    record.configVersion === authority.configVersion
  );
}
/** Bounded prompt input: at most this many records are injected or returned. */
export const ORGANIZATION_MEMORY_READ_LIMIT = 20;
const ORGANIZATION_MEMORY_RETAINED = 100;

function memoryFile(workspaceId: string, userId: string): string {
  const owner = createHash('sha256').update(userId).digest('hex');
  return path.join(getProjectDataDir(workspaceId), 'users', owner, 'memory.json');
}
function load(filename: string): StoredMemory[] {
  if (!existsSync(filename)) return [];
  const parsed = JSON.parse(readFileSync(filename, 'utf8')) as unknown;
  return Array.isArray(parsed) ? (parsed as StoredMemory[]) : [];
}
function save(filename: string, records: StoredMemory[]): void {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  writeFileSync(`${filename}.tmp`, JSON.stringify(records.slice(-ORGANIZATION_MEMORY_RETAINED)), {
    mode: 0o600,
  });
  renameSync(`${filename}.tmp`, filename);
}
/** Memory text is agent-written and injected into prompts: redact it like any other context. */
function publicRecord({
  linkId: _linkId,
  configVersion: _configVersion,
  ...record
}: StoredMemory): OrganizationMemory {
  return {
    ...record,
    sourceRecord: redact(record.sourceRecord),
    content: redact(record.content),
  };
}

export function readOrganizationMemory(sessionId: string): OrganizationMemory[] {
  const authority = resolveOrganizationSessionAuthority(sessionId);
  if (!authority.tools.includes('projects:read')) return [];
  const links = listBusinessOrganizationProjectLinks(authority.serverId, authority.organizationId);
  return load(memoryFile(authority.workspaceId, authority.userId))
    .filter((record) => isCurrent(record, authority, links))
    .slice(-ORGANIZATION_MEMORY_READ_LIMIT)
    .map(publicRecord);
}

export function appendOrganizationMemory(
  sessionId: string,
  input: Pick<OrganizationMemory, 'projectId' | 'sourceRecord' | 'content'>,
): OrganizationMemory {
  const authority = resolveOrganizationSessionAuthority(sessionId);
  const linkId = listBusinessOrganizationProjectLinks(
    authority.serverId,
    authority.organizationId,
  ).get(input.projectId);
  if (
    !authority.tools.includes('projects:read') ||
    !authority.projectIds.includes(input.projectId) ||
    !linkId
  )
    throw new Error('Memory source unavailable');
  const filename = memoryFile(authority.workspaceId, authority.userId);
  const record: StoredMemory = {
    ...input,
    id: randomUUID(),
    serverId: authority.serverId,
    organizationId: authority.organizationId,
    agentId: authority.agentId,
    linkId,
    configVersion: authority.configVersion,
    timestamp: new Date().toISOString(),
  };
  save(filename, [...load(filename), record]);
  return publicRecord(record);
}

/** Drop this agent's records the current authority no longer covers. Runs on revocation so a
 * later relink, re-grant or scope widening cannot resurrect them. */
export function pruneOrganizationMemory(sessionId: string, serverId = getActiveOrgId()): void {
  if (serverId !== getActiveOrgId()) return; // A Server switch is not access loss.
  const identity = organizationSessionIdentity(sessionId);
  const owner = (
    getDb().prepare('SELECT owner_user_id FROM sessions WHERE id = ?').get(sessionId) as
      | { owner_user_id: string | null }
      | undefined
  )?.owner_user_id;
  if (!identity || identity.server_id !== serverId || !owner) return;
  const filename = memoryFile(identity.workspace_id, owner);
  const records = load(filename);
  if (records.length === 0) return;
  const authority = currentOrganizationAuthority(sessionId);
  const links = listBusinessOrganizationProjectLinks(serverId, identity.organization_id);
  const kept = records.filter((record) => {
    if (record.agentId !== identity.agent_id || record.organizationId !== identity.organization_id)
      return true;
    return !!authority && isCurrent(record, authority, links);
  });
  if (kept.length !== records.length) save(filename, kept);
}

/** Re-check every stored organization session's memory against current authority. Validity
 * is computed from current state, so a revocation must prune at the moment it happens: once
 * access returns, nothing distinguishes a stale record. Live contexts and grants are not a
 * reliable trigger (a restart or capability expiry clears them), so this walks the persisted
 * session identities. One session per (owner, agent) suffices: authority depends on no other
 * session field. */
export function pruneAllOrganizationMemory(): void {
  const serverId = getActiveOrgId();
  const rows = getDb()
    .prepare(
      `SELECT MIN(w.session_id) AS sessionId, w.workspace_id AS workspaceId
         FROM organization_workflow_sessions w
         JOIN sessions s ON s.id = w.session_id
        WHERE w.server_id = ? AND s.owner_user_id IS NOT NULL
        GROUP BY w.workspace_id, w.agent_id, s.owner_user_id`,
    )
    .all(serverId) as { sessionId: string; workspaceId: string }[];
  for (const { sessionId, workspaceId } of rows) {
    // A workspace absent from the registry (mid-reload) is not evidence of access loss.
    if (!findProjectForServer(serverId, workspaceId)) continue;
    try {
      pruneOrganizationMemory(sessionId, serverId);
    } catch {
      /* One unreadable file must not leave the others unpruned. */
    }
  }
}

onOrganizationContextInvalidated((sessionId, serverId) =>
  pruneOrganizationMemory(sessionId, serverId),
);
// Every authority mutation (project ACLs, memberships, links, agent configuration) notifies here.
registerOrganizationAccessRevalidator(() => {
  try {
    pruneAllOrganizationMemory();
  } catch {
    /* The session database may not be open yet during startup. */
  }
});
