/** Private, attributable memory. Shared workspace MEMORY.md is never injected into org turns. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { getProjectDataDir } from './project-model.js';
import { resolveOrganizationSessionAuthority } from './organization-capabilities.js';

export interface OrganizationMemory {
  id: string;
  serverId: string;
  organizationId: string;
  projectId: string;
  sourceRecord: string;
  content: string;
  timestamp: string;
}
function store(sessionId: string) {
  const authority = resolveOrganizationSessionAuthority(sessionId);
  const owner = createHash('sha256').update(authority.userId).digest('hex');
  const filename = path.join(
    getProjectDataDir(authority.workspaceId),
    'users',
    owner,
    'memory.json',
  );
  const records: OrganizationMemory[] = existsSync(filename)
    ? JSON.parse(readFileSync(filename, 'utf8'))
    : [];
  return { authority, filename, records };
}
export function readOrganizationMemory(sessionId: string): OrganizationMemory[] {
  const { authority, records } = store(sessionId);
  if (!authority.tools.includes('projects:read')) return [];
  return records
    .filter(
      (record) =>
        record.serverId === authority.serverId &&
        record.organizationId === authority.organizationId &&
        authority.projectIds.includes(record.projectId),
    )
    .slice(-20);
}
export function appendOrganizationMemory(
  sessionId: string,
  input: Pick<OrganizationMemory, 'projectId' | 'sourceRecord' | 'content'>,
): OrganizationMemory {
  const { authority, filename, records } = store(sessionId);
  if (!authority.tools.includes('projects:read') || !authority.projectIds.includes(input.projectId))
    throw new Error('Memory source unavailable');
  const record: OrganizationMemory = {
    ...input,
    id: randomUUID(),
    serverId: authority.serverId,
    organizationId: authority.organizationId,
    timestamp: new Date().toISOString(),
  };
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  writeFileSync(`${filename}.tmp`, JSON.stringify([...records, record].slice(-100)), {
    mode: 0o600,
  });
  renameSync(`${filename}.tmp`, filename);
  return record;
}
