import path from 'path';
import type { Project } from './types.js';
import { listEnabledSkills } from './agent-skills-list.js';
import { mergeDecryptedSkillCredentialsIntoEnv } from './skill-credentials-store.js';
import { readCredentialsSchemaForSkill } from './skill-credentials-resolve.js';

/**
 * Injects per-user skill credential env vars for every skill currently enabled
 * for the agent (project + default merge, minus overrides). Best-effort: logs
 * soft TOOL_ERROR-shaped line on failure without blocking spawn.
 *
 * Crucial invariant: rows are gated by the credential schema *resolved for
 * the spawning agent's workspace* (workspace `{ahw}/skills/{id}/SKILL.md` →
 * bundled default → registry — same priority as `listEnabledSkills` /
 * `GET /api/agents/:agentId/skills/:skillId`). A key accepted via project B's
 * forked SKILL.md must NOT show up in project A's spawn env, even though the
 * row is keyed only on `(user_id, skill_id, key_name)` in storage.
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
    const projectWorkspaces = project.ahw ? [project.ahw] : [];
    const allowedKeysBySkillId = new Map<string, ReadonlySet<string>>();
    for (const skillId of skillIds) {
      const schema = readCredentialsSchemaForSkill(skillId, { projectWorkspaces });
      // Malformed frontmatter → empty allowlist: refuse to leak unverified
      // env vars from a row whose declaration we can't trust right now.
      if (schema.error) {
        allowedKeysBySkillId.set(skillId, new Set());
        continue;
      }
      allowedKeysBySkillId.set(skillId, new Set(schema.credentials.map((c) => c.name)));
    }
    mergeDecryptedSkillCredentialsIntoEnv(ownerId, skillIds, base, allowedKeysBySkillId);
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
