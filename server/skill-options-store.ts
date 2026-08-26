/**
 * Per-user skill option selections — the non-secret sibling of
 * `skill-credentials-store.ts`. Values are owner-curated enum choices, stored
 * in plaintext (safe to render), keyed by `(user_id, skill_id, option_name)`.
 */

import { getOrgsDb } from './orgs.js';
import { v4 as uuidv4 } from 'uuid';

export interface SkillOptionSelectionRow {
  id: string;
  skill_id: string;
  option_name: string;
  value: string;
  updated_at: string;
  created_at: string;
}

/** All of one user's option selections, optionally filtered to one skill. */
export function listUserSkillOptions(
  userId: string,
  skillIdFilter?: string | null,
): SkillOptionSelectionRow[] {
  const db = getOrgsDb();
  if (skillIdFilter) {
    return db
      .prepare(
        `SELECT id, skill_id, option_name, value, updated_at, created_at
         FROM user_skill_options WHERE user_id = ? AND skill_id = ?
         ORDER BY skill_id, option_name`,
      )
      .all(userId, skillIdFilter) as SkillOptionSelectionRow[];
  }
  return db
    .prepare(
      `SELECT id, skill_id, option_name, value, updated_at, created_at
       FROM user_skill_options WHERE user_id = ?
       ORDER BY skill_id, option_name`,
    )
    .all(userId) as SkillOptionSelectionRow[];
}

export function upsertUserSkillOption(opts: {
  userId: string;
  skillId: string;
  optionName: string;
  value: string;
}): SkillOptionSelectionRow {
  const db = getOrgsDb();
  const now = new Date().toISOString();
  const existing = db
    .prepare(
      'SELECT id FROM user_skill_options WHERE user_id = ? AND skill_id = ? AND option_name = ?',
    )
    .get(opts.userId, opts.skillId, opts.optionName) as { id: string } | undefined;

  if (existing) {
    db.prepare('UPDATE user_skill_options SET value = ?, updated_at = ? WHERE id = ?').run(
      opts.value,
      now,
      existing.id,
    );
    return db
      .prepare(
        'SELECT id, skill_id, option_name, value, updated_at, created_at FROM user_skill_options WHERE id = ?',
      )
      .get(existing.id) as SkillOptionSelectionRow;
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO user_skill_options (id, user_id, skill_id, option_name, value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, opts.userId, opts.skillId, opts.optionName, opts.value, now, now);
  return db
    .prepare(
      'SELECT id, skill_id, option_name, value, updated_at, created_at FROM user_skill_options WHERE id = ?',
    )
    .get(id) as SkillOptionSelectionRow;
}

export function deleteUserSkillOption(
  userId: string,
  skillId: string,
  optionName: string,
): { ok: boolean } {
  const db = getOrgsDb();
  const res = db
    .prepare(
      'DELETE FROM user_skill_options WHERE user_id = ? AND skill_id = ? AND option_name = ?',
    )
    .run(userId, skillId, optionName);
  return { ok: res.changes > 0 };
}

/** Map of `option_name -> selected value` for one user + skill. */
export function getUserSkillOptionValues(userId: string, skillId: string): Map<string, string> {
  const rows = listUserSkillOptions(userId, skillId);
  return new Map(rows.map((r) => [r.option_name, r.value]));
}
