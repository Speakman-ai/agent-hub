import { getActiveOrgId } from './orgs.js';
import { listMembersForOrg } from './memberships-store.js';
import type { Agent } from './types.js';

function heartbeatIsConfigured(agent: Agent): boolean {
  const heartbeat = agent.heartbeat;
  return Boolean(
    heartbeat?.enabled ||
    heartbeat?.interval?.trim() ||
    heartbeat?.prompt?.trim() ||
    heartbeat?.model?.trim(),
  );
}

function ensureHeartbeat(agent: Agent): NonNullable<Agent['heartbeat']> {
  if (!agent.heartbeat) {
    agent.heartbeat = { enabled: false, interval: '', prompt: '' };
  }
  if (agent.heartbeat.shared === undefined) {
    agent.heartbeat.shared = 0;
  }
  return agent.heartbeat;
}

export function defaultHeartbeatOwnerUserId(): string | null {
  try {
    const owner = listMembersForOrg(getActiveOrgId()).find((m) => m.role === 'Owner');
    return owner?.userId ?? null;
  } catch {
    return null;
  }
}

export function assignHeartbeatOwnerIfNeeded(agent: Agent): boolean {
  if (!heartbeatIsConfigured(agent)) return false;
  const heartbeat = ensureHeartbeat(agent);
  if (!heartbeat.owner_user_id) {
    const ownerUserId = defaultHeartbeatOwnerUserId();
    if (!ownerUserId) return false;
    heartbeat.owner_user_id = ownerUserId;
    return true;
  }
  return false;
}

export function backfillHeartbeatOwner(agent: Agent, saveProjects: () => void): void {
  if (assignHeartbeatOwnerIfNeeded(agent)) saveProjects();
}

export function backfillHeartbeatOwners(allAgents: () => Agent[], saveProjects: () => void): void {
  let changed = false;
  for (const agent of allAgents()) {
    if (assignHeartbeatOwnerIfNeeded(agent)) changed = true;
  }
  if (changed) saveProjects();
}

export function resetHeartbeatOwnerBackfillForTests(): void {
  // Backfill no longer keeps one-shot state. Preserve this test hook for older
  // focused tests that reset shared heartbeat ownership helpers in beforeEach.
}
