import type {
  Stmts,
  SessionRow,
  SessionAgentRow,
  SessionAgentDetail,
  EnrichedAgent,
  Project,
  AppConfig,
} from './types.js';
import { enrichSessionForClient, type SessionWireRow } from './session-checkpoint-rewind.js';
import { resolveAdvisorEngineAndModel } from './session-multi-engine.js';

export function listSessionAgents(
  stmts: Pick<Stmts, 'getSessionAgents'>,
  session: SessionRow,
  getEnrichedAgent: (agentId: string) => EnrichedAgent | null,
  // When provided, the advisor's reported engine is resolved the same way the
  // spawn resolves it (participant override → per-user override → agent engine)
  // so the roster/model-picker never diverges from the CLI that actually runs.
  // Omitted → fall back to the participant override or the agent's own engine.
  config?: AppConfig,
): SessionAgentDetail[] {
  const primary = getEnrichedAgent(session.agent_id);
  const advisorRows = stmts.getSessionAgents.all(session.id) as SessionAgentRow[];
  const advisors: SessionAgentDetail[] = [];
  for (const row of advisorRows) {
    const agent = getEnrichedAgent(row.agent_id);
    if (!agent) continue;
    const engineOverride = row.engine?.trim() || null;
    const effectiveEngine = config
      ? resolveAdvisorEngineAndModel(config, {
          agentId: agent.id,
          agentEngine: agent.engine,
          agentModel: agent.model ?? null,
          sessionEngine: engineOverride,
          sessionModel: row.model,
          ownerUserId: session.owner_user_id ?? null,
        }).engine
      : engineOverride || agent.engine || 'claude-code';
    advisors.push({
      participantId: row.id,
      id: agent.id,
      name: agent.name,
      color: agent.color || '#666',
      engine: effectiveEngine,
      engineOverride,
      model: row.model,
      position: row.position,
      role: 'advisor',
      projectId: agent.projectId,
      projectName: agent.projectName,
    });
  }

  const roster: SessionAgentDetail[] = [];
  if (primary) {
    roster.push({
      participantId: `executor:${primary.id}`,
      id: primary.id,
      name: primary.name,
      color: primary.color || '#666',
      engine: session.engine || primary.engine || 'claude-code',
      model: session.model,
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
  // Optional app config so advisor engines are reported using the same
  // resolution as the spawn (per-user override aware). See listSessionAgents.
  config?: AppConfig,
): SessionWireRow & { agents: SessionAgentDetail[]; advisor_count: number } {
  const agents = listSessionAgents(stmts, session, getEnrichedAgent, config);
  return {
    ...enrichSessionForClient(session, stmts, project),
    agents,
    advisor_count: Math.max(0, agents.length - 1),
  };
}
