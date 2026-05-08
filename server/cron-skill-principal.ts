import type { CronRow, Project } from './types.js';

function agentBelongs(agentId: string, project: Project): boolean {
  return (project.agents ?? []).some((a) => a.id === agentId);
}

/**
 * Picks the project agent whose skill toggles govern `listEnabledSkills` for a
 * cron run. Order: optional per-cron `skill_principal_agent_id` (when valid) →
 * optional `project.cronSkillPrincipalAgentId` → exactly one agent on the project.
 * When multiple agents exist and neither explicit field resolves, returns
 * `undefined` so callers **omit** spawn credential merge rather than invent a fake
 * id (which would treat every bundled skill as enabled).
 */
export function resolveCronSkillPrincipalAgentId(
  cron: Pick<CronRow, 'skill_principal_agent_id'>,
  project: Project,
): string | undefined {
  const cronField = (cron.skill_principal_agent_id ?? '').trim();
  if (cronField) {
    if (agentBelongs(cronField, project)) return cronField;
    console.warn(
      `[Cron] skill_principal_agent_id "${cronField}" is not an agent on project ${project.id}; trying project default / sole-agent fallback`,
    );
  }

  const projectDefault = (project.cronSkillPrincipalAgentId ?? '').trim();
  if (projectDefault) {
    if (agentBelongs(projectDefault, project)) return projectDefault;
    console.warn(
      `[Cron] cronSkillPrincipalAgentId "${projectDefault}" is invalid for project ${project.id}; skipping that default`,
    );
  }

  const agents = project.agents ?? [];
  if (agents.length === 1 && agents[0]?.id) {
    return agents[0].id;
  }

  if (agents.length > 1) {
    console.warn(
      `[Cron] No unambiguous skill principal for multi-agent project "${project.id}" (${agents.length} agents) — omitting per-cron skill credential merge. Set crons.skill_principal_agent_id (API) or project.cronSkillPrincipalAgentId (projects.json).`,
    );
  }
  return undefined;
}
