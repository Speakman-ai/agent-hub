import type {
  Stmts,
  SessionRow,
  SessionAgentRow,
  SessionAgentDetail,
  EnrichedAgent,
  Project,
} from './types.js';
import { enrichSessionForClient, type SessionWireRow } from './session-checkpoint-rewind.js';

export function listSessionAgents(
  stmts: Pick<Stmts, 'getSessionAgents'>,
  session: SessionRow,
  getEnrichedAgent: (agentId: string) => EnrichedAgent | null,
): SessionAgentDetail[] {
  const primary = getEnrichedAgent(session.agent_id);
  const advisorRows = stmts.getSessionAgents.all(session.id) as SessionAgentRow[];
  const advisors: SessionAgentDetail[] = [];
  for (const row of advisorRows) {
    const agent = getEnrichedAgent(row.agent_id);
    if (!agent) continue;
    advisors.push({
      id: agent.id,
      name: agent.name,
      color: agent.color || '#666',
      position: row.position,
      role: 'advisor',
      projectId: agent.projectId,
      projectName: agent.projectName,
    });
  }

  const roster: SessionAgentDetail[] = [];
  if (primary) {
    roster.push({
      id: primary.id,
      name: primary.name,
      color: primary.color || '#666',
      position: -1,
      role: 'executor',
      projectId: primary.projectId,
      projectName: primary.projectName,
    });
  }
  roster.push(...advisors);
  return roster;
}

export function enrichSessionWithAgents(
  session: SessionRow,
  stmts: Stmts,
  getEnrichedAgent: (agentId: string) => EnrichedAgent | null,
  // Optional owning project — threaded so `can_design_mode` reflects workflow
  // (no-code) projects (data-dir design store), not just worktree-backed dev
  // sessions. Omitted → worktree-only fallback (see enrichSessionForClient).
  project?: Project | null,
): SessionWireRow & { agents: SessionAgentDetail[]; advisor_count: number } {
  const agents = listSessionAgents(stmts, session, getEnrichedAgent);
  return {
    ...enrichSessionForClient(session, stmts, project),
    agents,
    advisor_count: Math.max(0, agents.length - 1),
  };
}
