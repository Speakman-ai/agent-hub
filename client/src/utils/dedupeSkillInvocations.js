// Collapse a list of skill_invocations rows to one entry per skill_id, keeping
// the most recent invocation (by created_at). The wiki spec for the
// <agenthub:skill> protocol says the session sidebar must dedupe by stable
// skill id so that hot-reloads / repeat loads don't pile up duplicate rows.
//
// Accepts rows in either snake_case (`{skill_id, created_at}`) or camelCase
// (`{skillId, createdAt}`). Unknown shapes fall through unchanged so callers
// can keep using `.id` as a React key when needed.
export function dedupeSkillInvocations(rows) {
  if (!Array.isArray(rows)) return [];
  const byId = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const skillId = row.skill_id ?? row.skillId;
    if (!skillId) continue;
    const createdAt = row.created_at ?? row.createdAt ?? '';
    const existing = byId.get(skillId);
    if (!existing) {
      byId.set(skillId, row);
      continue;
    }
    const existingCreatedAt = existing.created_at ?? existing.createdAt ?? '';
    // Lexicographic compare on ISO-8601 strings is equivalent to chronological
    // order, so we avoid an extra Date parse per row.
    if (String(createdAt) >= String(existingCreatedAt)) {
      byId.set(skillId, row);
    }
  }
  return Array.from(byId.values());
}
