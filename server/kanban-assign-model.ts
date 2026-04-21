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
    const allowed = cfg.engineValidModels[engine] || [];
    if (!allowed.includes(trimmed)) {
      return {
        ok: false,
        error: `Model "${trimmed}" is not valid for engine "${engine}". Allowed: ${allowed.join(', ')}`,
      };
    }
    return { ok: true };
  }
  if (!cfg.allValidModels.includes(trimmed)) {
    return {
      ok: false,
      error: `Invalid model "${trimmed}". Must be one of: ${cfg.allValidModels.join(', ')}`,
    };
  }
  return { ok: true };
}
