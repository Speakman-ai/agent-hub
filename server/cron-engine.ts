import type { CronRow, Project } from './types.js';
import { ALL_SUPPORTED_ENGINES, type SupportedEngine } from './engine-availability.js';
import { resolveCronSkillPrincipalAgentId } from './cron-skill-principal.js';

/**
 * Default engine for a cron that has neither an explicit `engine` value nor
 * a resolvable skill principal agent. Historically every cron targeted
 * Claude Code, so we keep that as the fallback to preserve existing
 * behaviour for rows created before the column existed.
 */
export const DEFAULT_CRON_ENGINE: SupportedEngine = 'claude-code';

export function isSupportedEngine(value: unknown): value is SupportedEngine {
  return typeof value === 'string' && (ALL_SUPPORTED_ENGINES as readonly string[]).includes(value);
}

/**
 * Resolve the engine a cron should run under. Order:
 *
 *   1. `cron.engine` — explicit per-row override (validated on write).
 *   2. Skill principal agent's `engine` — so a cron tied to a project
 *      whose principal agent is on Cursor / Gemini / Codex inherits that
 *      engine without extra config.
 *   3. `DEFAULT_CRON_ENGINE` (`claude-code`) — historical default.
 *
 * Pure function — accepts the cron row and the resolved project (which may
 * be null when the cron has no project mapping). Any callers that need to
 * compute the project should do so first via `findProjectForCron` /
 * `getProjects().find(...)`.
 */
export function resolveCronEngine(
  cron: Pick<CronRow, 'engine' | 'skill_principal_agent_id'>,
  project: Project | null,
): SupportedEngine {
  if (isSupportedEngine(cron.engine)) return cron.engine;

  if (project) {
    const principalId = resolveCronSkillPrincipalAgentId(cron, project);
    if (principalId) {
      const agent = (project.agents ?? []).find((a) => a.id === principalId);
      if (agent && isSupportedEngine(agent.engine)) return agent.engine;
    }
  }

  return DEFAULT_CRON_ENGINE;
}
