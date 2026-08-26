/**
 * Per-project default-on skills: the owner-curated list of skill ids that are
 * auto-loaded into every session of a project (see skill-router's
 * `projectDefaultSkillIds`). Thin wrapper over the prepared statements in db.ts.
 */

import { getStmts } from './db.js';

/**
 * Read a project's default-on skill ids. Throws on a real DB failure (statement
 * unavailable, DB closed, query error) rather than masking it as an empty list —
 * an operational failure must stay distinguishable from a genuinely empty config
 * so the REST endpoint can 500 and the routing caller can log it. Callers that
 * must not fail hard (e.g. per-turn skill routing) catch and report explicitly.
 */
export function listProjectDefaultSkillIds(projectId: string): string[] {
  const rows = getStmts().getProjectDefaultSkills.all(projectId) as Array<{ skill_id: string }>;
  return rows.map((r) => r.skill_id);
}

export function addProjectDefaultSkill(projectId: string, skillId: string): void {
  getStmts().addProjectDefaultSkill.run(projectId, skillId);
}

export function removeProjectDefaultSkill(projectId: string, skillId: string): { ok: boolean } {
  const res = getStmts().deleteProjectDefaultSkill.run(projectId, skillId) as { changes: number };
  return { ok: res.changes > 0 };
}
