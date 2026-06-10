/**
 * Two distinct skill lists live here, and the distinction matters:
 *
 * - `listMergedSkills(skillsDir)` — the **unfiltered options list**: every
 *   project + bundled skill, source-tagged, with NO per-agent enable/disable
 *   overrides and NO allowlist applied. This is the source of truth for the
 *   Settings UI that *edits* an agent's allowlist (`GET /agents/:id/skills`),
 *   so a previously denied skill can always be re-added.
 * - `listEnabledSkills(agentId, skillsDir, allowedSkills)` — the **filtered
 *   runtime list**: `listMergedSkills` with the agent's enable/disable overrides
 *   AND the caller-supplied allowlist layered on top. This is what the prompt
 *   builder and spawn-credential resolution consume, so a restricted agent only
 *   ever sees its allowed set. The allowlist is passed in (resolved from the
 *   authoritative agent record) rather than re-looked-up here, so a lookup miss
 *   can never fail OPEN and widen access on this access-control boundary.
 *
 * Keep these separate: never back the Settings options list with
 * `listEnabledSkills`, or operators lose the ability to re-grant a denied skill.
 *
 * Both build on the `collectSkillsFromDir` filesystem primitive (routes/skills),
 * which is the seam the prompt-builder tests mock to control the skill set.
 */

import type { SkillInfo, SkillWithSource } from './routes/skills.js';
import { collectSkillsFromDir, DEFAULT_SKILLS_DIR } from './routes/skills.js';
import { getStmts } from './db.js';

export type { SkillInfo, SkillWithSource };

/**
 * Pure allowlist filter shared by the prompt builder. When `allowedSkills` is
 * not an array (`null`/`undefined`), the agent is unrestricted and every skill
 * passes through. When it is an array, only skills whose `id` is in the list
 * survive (an empty array filters everything out).
 */
export function filterSkillsByAllowlist(
  skills: SkillInfo[],
  allowedSkills: string[] | null | undefined,
): SkillInfo[] {
  if (!Array.isArray(allowedSkills)) return skills;
  const allowed = new Set(allowedSkills);
  return skills.filter((s) => allowed.has(s.id));
}

/**
 * Pure predicate used by the `<agenthub:skill>` trigger to enforce the
 * allowlist. Unrestricted agents (`null`/`undefined`) may load anything.
 */
export function isSkillAllowed(
  skillId: string,
  allowedSkills: string[] | null | undefined,
): boolean {
  if (!Array.isArray(allowedSkills)) return true;
  return allowedSkills.includes(skillId);
}

export function applyAgentSkillOverrides(agentId: string, skills: SkillInfo[]): SkillInfo[] {
  try {
    const stmts = getStmts();
    const overrides = stmts.getAgentSkillOverrides.all(agentId) as Array<{
      skill_id: string;
      enabled: number;
    }>;
    const disabledSet = new Set(overrides.filter((o) => !o.enabled).map((o) => o.skill_id));
    if (disabledSet.size === 0) return skills;
    return skills.filter((s) => !disabledSet.has(s.id));
  } catch {
    return skills;
  }
}

/**
 * Unfiltered merge of a project's skills dir + the bundled default skills, each
 * tagged with its source (project wins over a same-id bundled skill). Applies
 * NO per-agent overrides and NO allowlist — see the module header. This is the
 * options list the Settings allowlist editor (`GET /agents/:id/skills`) must use
 * so a previously denied skill can always be re-added.
 */
export function listMergedSkills(skillsDir: string): SkillWithSource[] {
  const projectSkills: SkillWithSource[] = collectSkillsFromDir(skillsDir).map((s) => ({
    ...s,
    source: 'project',
  }));
  const defaultSkills: SkillWithSource[] = collectSkillsFromDir(DEFAULT_SKILLS_DIR).map((s) => ({
    ...s,
    source: 'default',
  }));
  const projectIds = new Set(projectSkills.map((s) => s.id));
  return [...projectSkills, ...defaultSkills.filter((s) => !projectIds.has(s.id))];
}

/**
 * The filtered runtime/prompt list: the unfiltered merge (`listMergedSkills`)
 * with the agent's enable/disable overrides AND allowlist layered on top.
 * Consumed by the prompt builder and spawn-credential resolution. Do NOT use
 * this to populate the Settings allowlist editor — use `listMergedSkills`.
 *
 * The caller supplies the already-resolved `allowedSkills` from the authoritative
 * agent record (`null`/`undefined` = the agent legitimately has no restriction;
 * an array = its whitelist). This function intentionally does NOT re-resolve the
 * agent: re-looking it up here would let a lookup miss fail OPEN and silently
 * widen access on what is an access-control boundary. Callers that only hold an
 * id must resolve the agent and fail closed on a miss (see
 * `mergeSkillCredentialSpawnEnv`).
 */
export function listEnabledSkills(
  agentId: string,
  skillsDir: string,
  allowedSkills: string[] | null | undefined,
): SkillInfo[] {
  const afterOverrides = applyAgentSkillOverrides(agentId, listMergedSkills(skillsDir));
  return filterSkillsByAllowlist(afterOverrides, allowedSkills);
}
