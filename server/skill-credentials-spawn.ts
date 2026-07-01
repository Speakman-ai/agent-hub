import type { Project } from './types.js';
import { listEnabledSkills } from './agent-skills-list.js';
import { mergeDecryptedSkillCredentialsIntoEnv } from './skill-credentials-store.js';
import { readCredentialsSchemaForSkill } from './skill-credentials-resolve.js';
import { hasLinearApiKey } from './linear-skill-auth-resolve.js';
import { resolveProjectSkillsDir } from './project-model.js';

/**
 * Injects per-user skill credential env vars for every skill currently enabled
 * for the agent (project + default merge, minus overrides). Best-effort: logs
 * soft TOOL_ERROR-shaped line on failure without blocking spawn.
 *
 * Crucial invariant: rows are gated by the credential schema *resolved for
 * the spawning agent's project skill store (`project-skills/<projectId>/<id>/SKILL.md` →
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
    const skillsRoot = resolveProjectSkillsDir(project);
    // Resolve the agent's allowlist from the project we already hold (the
    // authoritative record). Access boundary: if the agent can't be resolved
    // from its project, fail CLOSED (empty allowlist → no skills → no
    // credentials) rather than granting every skill's credentials. A resolved
    // agent with no `allowedSkills` is legitimately unrestricted (`null`).
    const spawningAgent = project.agents?.find((a) => a.id === agentId);
    const allowedSkills: string[] | null = spawningAgent
      ? (spawningAgent.allowedSkills ?? null)
      : [];
    const enabled = listEnabledSkills(agentId, skillsRoot, allowedSkills);
    const skillIds = enabled.map((s) => s.id);
    const allowedKeysBySkillId = new Map<string, ReadonlySet<string>>();
    for (const skillId of skillIds) {
      const schema = readCredentialsSchemaForSkill(skillId, { projectSkillsDirs: [skillsRoot] });
      // Malformed frontmatter → empty allowlist: refuse to leak unverified
      // env vars from a row whose declaration we can't trust right now.
      if (schema.error) {
        allowedKeysBySkillId.set(skillId, new Set());
        continue;
      }
      allowedKeysBySkillId.set(skillId, new Set(schema.credentials.map((c) => c.name)));
    }
    mergeDecryptedSkillCredentialsIntoEnv(ownerId, skillIds, base, allowedKeysBySkillId);
    // Emit a soft diagnostic when the linear skill is enabled but its API key
    // is absent from the final spawn env (not stored + not in host environment).
    if (
      skillIds.includes('linear') &&
      !hasLinearApiKey(base as Record<string, string | undefined>)
    ) {
      console.warn(
        `TOOL_ERROR | ${new Date().toISOString()} | skill-credentials | linear | warn | LINEAR_API_KEY not configured — linear skill is enabled but the key is missing; store it via Settings → Skills → Credentials | ${JSON.stringify({ v: 2, sev: 'soft', resolution: 'none', tags: ['skill-credentials', 'linear', 'missing-key'] })}`,
      );
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
      tags: ['skill-credentials', 'spawn'],
    });
    console.error(
      `TOOL_ERROR | ${new Date().toISOString()} | skill-credentials | spawn merge | error | ${summary} | ${meta}`,
    );
  }
}
