import type { AppConfig, Project } from './types.js';

/**
 * Validates a non-empty assign_model string for kanban APIs.
 * When the card is tied to an agent by assignee name, validates against that
 * engine's allowlist; otherwise requires membership in the global union.
 */
export function validateKanbanAssignModel(
  trimmed: string,
  project: Project,
  assigneeName: string | null | undefined,
  cfg: AppConfig,
): { ok: true } | { ok: false; error: string } {
  const agent = assigneeName ? project.agents?.find((a) => a.name === assigneeName) : undefined;
  if (agent) {
    const engine = agent.engine || 'claude-code';
    return validateKanbanAssignModelForEngine(trimmed, engine, cfg);
  }
  if (!cfg.allValidModels.includes(trimmed)) {
    return {
      ok: false,
      error: `Invalid model "${trimmed}". Must be one of: ${cfg.allValidModels.join(', ')}`,
    };
  }
  return { ok: true };
}

/**
 * Engine-keyed variant. Use this when the spawn engine is already resolved
 * (e.g. by `resolveEffectiveEngineAndModel`) and may differ from the agent's
 * shared `agent.engine` — otherwise the agent-name lookup in
 * `validateKanbanAssignModel` falls back to the global `allValidModels` union
 * and silently accepts a model that belongs to a different engine than the
 * one that will actually spawn.
 */
export function validateKanbanAssignModelForEngine(
  trimmed: string,
  engine: string,
  cfg: AppConfig,
): { ok: true } | { ok: false; error: string } {
  const allowed = cfg.engineValidModels[engine] || [];
  if (!allowed.includes(trimmed)) {
    return {
      ok: false,
      error: `Model "${trimmed}" is not valid for engine "${engine}". Allowed: ${allowed.join(', ')}`,
    };
  }
  return { ok: true };
}
