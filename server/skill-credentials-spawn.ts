import path from 'path';
import type { Project } from './types.js';
import { listEnabledSkills } from './agent-skills-list.js';
import { mergeDecryptedSkillCredentialsIntoEnv } from './skill-credentials-store.js';

/**
 * Injects per-user skill credential env vars for every skill currently enabled
 * for the agent (project + default merge, minus overrides). Best-effort: logs
 * soft TOOL_ERROR-shaped line on failure without blocking spawn.
 */
export function mergeSkillCredentialSpawnEnv(
  base: NodeJS.ProcessEnv,
  opts: {
    ownerId: string | null;
    agentId: string;
    project: Project;
  },
): void {
  const { ownerId, agentId, project } = opts;
  if (!ownerId) return;
  try {
    const skillsRoot = project.ahw ? path.join(project.ahw, 'skills') : '';
    const enabled = listEnabledSkills(agentId, skillsRoot);
    const skillIds = enabled.map((s) => s.id);
    mergeDecryptedSkillCredentialsIntoEnv(ownerId, skillIds, base);
  } catch (err) {
    const summary = (err as Error).message
      .replace(/[\r\n|]+/g, ' ')
      .trim()
      .slice(0, 200);
    const meta = JSON.stringify({
      v: 2,
      sev: 'soft',
      resolution: 'recovered',
      tags: ['skill-credentials', 'spawn'],
    });
    console.error(
      `TOOL_ERROR | ${new Date().toISOString()} | skill-credentials | spawn merge | error | ${summary} | ${meta}`,
    );
  }
}
