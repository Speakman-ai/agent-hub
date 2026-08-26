import type { Project } from './types.js';
import { listEnabledSkills } from './agent-skills-list.js';
import { readOptionsSchemaForSkill } from './skill-options-resolve.js';
import { isValidOptionValue } from './skill-options-declaration.js';
import { getUserSkillOptionValues } from './skill-options-store.js';
import { resolveProjectSkillsDir } from './project-model.js';

/**
 * Injects per-user skill OPTION env vars for every skill currently enabled for
 * the agent. For each declared option we inject the user's stored selection
 * when it is a legal choice, else the option's default. Non-secret; mirrors the
 * schema-gated resolution boundary of `mergeSkillCredentialSpawnEnv` so a
 * project B fork's option can't leak into project A's spawn env.
 *
 * Never overwrites an env var already set to a non-empty value. Best-effort:
 * logs a soft TOOL_ERROR-shaped line on failure without blocking spawn.
 */
export function mergeSkillOptionSpawnEnv(
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
    const skillsRoot = resolveProjectSkillsDir(project);
    const spawningAgent = project.agents?.find((a) => a.id === agentId);
    // Fail closed: an unresolved agent gets an empty allowlist (no skills → no
    // options), same access boundary as the credential spawn path.
    const allowedSkills: string[] | null = spawningAgent
      ? (spawningAgent.allowedSkills ?? null)
      : [];
    const enabled = listEnabledSkills(agentId, skillsRoot, allowedSkills);

    for (const skill of enabled) {
      const schema = readOptionsSchemaForSkill(skill.id, { projectSkillsDirs: [skillsRoot] });
      // Malformed frontmatter → inject nothing for this skill.
      if (schema.error || schema.options.length === 0) continue;
      const selections = getUserSkillOptionValues(ownerId, skill.id);
      for (const spec of schema.options) {
        const cur = base[spec.name];
        if (cur !== undefined && cur !== null && String(cur).trim() !== '') continue;
        const chosen = selections.get(spec.name);
        const value = isValidOptionValue(spec, chosen) ? (chosen as string) : spec.default;
        if (value) base[spec.name] = value;
      }
    }
  } catch (err) {
    const summary = (err as Error).message
      .replace(/[\r\n|]+/g, ' ')
      .trim()
      .slice(0, 200);
    const meta = JSON.stringify({
      v: 2,
      sev: 'soft',
      resolution: 'recovered',
      tags: ['skill-options', 'spawn'],
    });
    console.error(
      `TOOL_ERROR | ${new Date().toISOString()} | skill-options | spawn merge | error | ${summary} | ${meta}`,
    );
  }
}
