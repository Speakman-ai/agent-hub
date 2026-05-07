/**
 * Computes the skill list exposed to agents (merge project + bundled default
 * dirs, honour per-agent enable/disable overrides). Shared by chat routing
 * and spawn credential resolution.
 */

import type { SkillInfo } from './routes/skills.js';
import { collectSkillsFromDir, DEFAULT_SKILLS_DIR } from './routes/skills.js';
import { getStmts } from './db.js';

export type { SkillInfo };

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

export function listEnabledSkills(agentId: string, skillsDir: string): SkillInfo[] {
  const projectSkills = collectSkillsFromDir(skillsDir);
  const defaultSkills = collectSkillsFromDir(DEFAULT_SKILLS_DIR);
  const projectIds = new Set(projectSkills.map((s) => s.id));
  const merged = [...projectSkills, ...defaultSkills.filter((s) => !projectIds.has(s.id))];
  return applyAgentSkillOverrides(agentId, merged);
}
